/**
 * Bundle size gate. PRD §7.1, rules R-PERF-001 / R-PERF-020, conflict C-4.
 *
 * A PR that pushes either bundle over budget fails the build. This exists
 * because the budgets are the reason GSAP was not adopted and Framer Motion is
 * confined to two chunks — without a mechanical gate those decisions decay.
 *
 * Usage:
 *   tsx scripts/check-bundle-size.ts [--dist <path>]
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

export interface Budget {
  label: string
  maxBytes: number
  maxLabel: string
}

export interface BudgetsFile {
  bundles: Record<string, Budget>
  bannedInBoardChunk: string[]
}

export interface ChunkSize {
  file: string
  gzipBytes: number
}

/** Recursively collect .js files under a directory. */
export function collectJsFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...collectJsFiles(full))
    else if (entry.endsWith('.js')) out.push(full)
  }
  return out
}

export const gzipSize = (path: string): number => gzipSync(readFileSync(path)).length

/**
 * Classify a chunk. The board route chunk is anything Vite named for the board
 * route; everything else counts toward `initial`.
 *
 * Match on the BASENAME only, never the full path. This repository lives at
 * `.../SharedBoard/`, so testing the whole path classified every chunk as the
 * board chunk and silently disabled the initial-bundle budget.
 */
export function classify(file: string): 'board' | 'initial' {
  return /board/i.test(basename(file)) ? 'board' : 'initial'
}

/**
 * The chunks the browser actually downloads before the app renders.
 *
 * Read out of the built `index.html`: the entry `<script type="module">` plus
 * every `<link rel="modulepreload">`, which is exactly the set Vite marks as
 * statically reachable from the entry. Async chunks — a lazy route, the
 * animation library behind the dashboard grid — appear in neither.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  This replaces "every chunk that is not the board chunk".                │
 * │                                                                          │
 * │  That approximation was honest while everything except the board loaded  │
 * │  eagerly. Once Framer Motion moved behind a dynamic import it counted    │
 * │  38 KB gzipped against a budget it does not spend, and the reported      │
 * │  figure was 40 KB worse than the truth. A budget that over-reports is    │
 * │  not "safely conservative": it is a number nobody can act on, and it     │
 * │  eventually fails a build for bytes no user downloads.                   │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Returns null when there is no index.html to read, so callers can fall back
 * rather than silently reporting a budget of zero.
 */
export function initialChunks(distDir: string): Set<string> | null {
  const html = join(distDir, 'index.html')
  if (!existsSync(html)) return null

  const source = readFileSync(html, 'utf8')
  const names = new Set<string>()
  const patterns = [
    /<script[^>]+type="module"[^>]+src="([^"]+)"/g,
    /<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g,
  ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(source)) !== null) if (m[1]) names.add(basename(m[1]))
  }
  return names.size > 0 ? names : null
}

export interface CheckResult {
  ok: boolean
  totals: Record<string, number>
  failures: string[]
  chunks: ChunkSize[]
  /** Chunks in neither budget — lazy routes and their vendors. */
  async: ChunkSize[]
}

export function checkSizes(distDir: string, budgets: BudgetsFile): CheckResult {
  const files = collectJsFiles(distDir)
  const chunks: ChunkSize[] = files.map(f => ({ file: f, gzipBytes: gzipSize(f) }))

  const eager = initialChunks(distDir)
  const totals: Record<string, number> = { initial: 0, board: 0 }
  const asyncChunks: ChunkSize[] = []

  for (const c of chunks) {
    const kind = classify(c.file)
    if (kind === 'board') {
      totals.board! += c.gzipBytes
      continue
    }
    // With no index.html to read, fall back to the old behaviour: count
    // everything. Over-reporting is the safe direction for a gate, and the
    // unit tests build fixture directories with no HTML in them.
    if (eager === null || eager.has(basename(c.file))) totals.initial! += c.gzipBytes
    else asyncChunks.push(c)
  }

  const failures: string[] = []
  for (const [key, budget] of Object.entries(budgets.bundles)) {
    const actual = totals[key] ?? 0
    if (actual > budget.maxBytes) {
      failures.push(
        `${budget.label}: ${(actual / 1024).toFixed(1)} KB exceeds budget ${budget.maxLabel}`,
      )
    }
  }

  return { ok: failures.length === 0, totals, failures, chunks, async: asyncChunks }
}

/* ── CLI ──────────────────────────────────────────────────────────────────── */

const isMain =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''))

if (isMain) {
  const root = resolve(import.meta.dirname, '..')
  const distArg = process.argv.indexOf('--dist')
  const distDir =
    distArg !== -1 ? resolve(process.argv[distArg + 1]!) : resolve(root, 'apps/web/dist')
  const budgets = JSON.parse(
    readFileSync(resolve(root, 'budgets.json'), 'utf8'),
  ) as BudgetsFile

  if (!existsSync(distDir)) {
    console.error(`[bundle-size] dist not found at ${distDir}. Run \`pnpm build\` first.`)
    process.exit(1)
  }

  const result = checkSizes(distDir, budgets)

  console.log('[bundle-size] gzipped totals:')
  for (const [key, budget] of Object.entries(budgets.bundles)) {
    const actual = result.totals[key] ?? 0
    const pct = ((actual / budget.maxBytes) * 100).toFixed(0)
    const mark = actual > budget.maxBytes ? 'FAIL' : 'ok'
    console.log(
      `  ${mark.padEnd(4)} ${budget.label}: ${(actual / 1024).toFixed(1)} KB / ${budget.maxLabel} (${pct}%)`,
    )
  }

  if (result.async.length > 0) {
    // Printed, not budgeted. These are downloaded only when their route is,
    // and seeing them keeps a lazy chunk from quietly becoming enormous just
    // because nothing measures it.
    const total = result.async.reduce((n, c) => n + c.gzipBytes, 0)
    console.log(`  --   async chunks (not in either budget): ${(total / 1024).toFixed(1)} KB`)
    for (const c of [...result.async].sort((a, b) => b.gzipBytes - a.gzipBytes).slice(0, 5)) {
      console.log(`         ${basename(c.file)} ${(c.gzipBytes / 1024).toFixed(1)} KB`)
    }
  }

  if (!result.ok) {
    console.error('\n[bundle-size] BUDGET EXCEEDED — PRD §7.1, R-PERF-020')
    for (const f of result.failures) console.error(`  - ${f}`)
    process.exit(1)
  }

  console.log('[bundle-size] all budgets met')
}
