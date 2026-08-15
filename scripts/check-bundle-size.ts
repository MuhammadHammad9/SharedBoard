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
 * route; everything else that ships on first load counts toward `initial`.
 *
 * Match on the BASENAME only, never the full path. This repository lives at
 * `.../SharedBoard/`, so testing the whole path classified every chunk as the
 * board chunk and silently disabled the initial-bundle budget.
 */
export function classify(file: string): 'board' | 'initial' {
  return /board/i.test(basename(file)) ? 'board' : 'initial'
}

export interface CheckResult {
  ok: boolean
  totals: Record<string, number>
  failures: string[]
  chunks: ChunkSize[]
}

export function checkSizes(distDir: string, budgets: BudgetsFile): CheckResult {
  const files = collectJsFiles(distDir)
  const chunks: ChunkSize[] = files.map(f => ({ file: f, gzipBytes: gzipSize(f) }))

  const totals: Record<string, number> = { initial: 0, board: 0 }
  for (const c of chunks) totals[classify(c.file)] += c.gzipBytes

  const failures: string[] = []
  for (const [key, budget] of Object.entries(budgets.bundles)) {
    const actual = totals[key] ?? 0
    if (actual > budget.maxBytes) {
      failures.push(
        `${budget.label}: ${(actual / 1024).toFixed(1)} KB exceeds budget ${budget.maxLabel}`,
      )
    }
  }

  return { ok: failures.length === 0, totals, failures, chunks }
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

  if (!result.ok) {
    console.error('\n[bundle-size] BUDGET EXCEEDED — PRD §7.1, R-PERF-020')
    for (const f of result.failures) console.error(`  - ${f}`)
    process.exit(1)
  }

  console.log('[bundle-size] all budgets met')
}
