/**
 * Board-route animation-library import check.
 *
 * Conflicts C-3 and C-4, rules R-SKILL-060, R-MOTION-051, R-MOTION-052,
 * R-PERF-021.
 *
 * Framer Motion is ~40 KB against a 200 KB board chunk budget, and its
 * rAF-driven animation competes with the render loop for exactly the main
 * thread the canvas needs. GSAP is not a dependency of this project at all.
 *
 * ESLint's no-restricted-imports catches direct violations in the files it
 * lints. This catches TRANSITIVE ones: an innocuous-looking component imported
 * by the board route that itself pulls in an animation library.
 *
 * Usage:
 *   tsx scripts/check-board-chunk-imports.ts
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'

export interface BudgetsFile {
  bannedInBoardChunk: string[]
}

/** Entry points whose transitive import graph must stay animation-library-free. */
export const BOARD_ENTRIES = [
  'apps/web/src/routes/Board.tsx',
  'apps/web/src/features/canvas',
]

const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx']

/** Extract every module specifier from a source file. */
export function extractImports(source: string): string[] {
  const specs: string[] = []
  const patterns = [
    /\bimport\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bexport\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
  ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(source)) !== null) if (m[1]) specs.push(m[1])
  }
  return specs
}

export const isBanned = (spec: string, banned: string[]): boolean =>
  banned.some(b => spec === b || spec.startsWith(`${b}/`))

/** Resolve a relative specifier to a real file, trying extensions and /index. */
function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(fromFile), spec)
  const candidates = [
    base,
    ...SOURCE_EXTS.map(e => base + e),
    // Written as .js in source (NodeNext style) but authored as .ts/.tsx
    ...SOURCE_EXTS.map(e => base.replace(/\.js$/, e)),
    ...SOURCE_EXTS.map(e => join(base, `index${e}`)),
  ]
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c
  }
  return null
}

function collectSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...collectSourceFiles(full))
    else if (SOURCE_EXTS.includes(extname(full))) out.push(full)
  }
  return out
}

export interface Violation {
  file: string
  specifier: string
  chain: string[]
}

/** Walk the transitive import graph from the given roots. */
export function scan(roots: string[], banned: string[]): Violation[] {
  const violations: Violation[] = []
  const seen = new Set<string>()

  const walk = (file: string, chain: string[]) => {
    if (seen.has(file)) return
    seen.add(file)

    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      return
    }

    for (const spec of extractImports(source)) {
      if (isBanned(spec, banned)) {
        violations.push({ file, specifier: spec, chain: [...chain, file] })
        continue
      }
      const local = resolveLocal(file, spec)
      if (local) walk(local, [...chain, file])
    }
  }

  for (const root of roots) {
    if (!existsSync(root)) continue
    const stat = statSync(root)
    const files = stat.isDirectory() ? collectSourceFiles(root) : [root]
    for (const f of files) walk(f, [])
  }

  return violations
}

/* ── CLI ──────────────────────────────────────────────────────────────────── */

const isMain =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''))

if (isMain) {
  const root = resolve(import.meta.dirname, '..')
  const budgets = JSON.parse(
    readFileSync(resolve(root, 'budgets.json'), 'utf8'),
  ) as BudgetsFile
  const roots = BOARD_ENTRIES.map(p => resolve(root, p))
  const present = roots.filter(existsSync)

  if (present.length === 0) {
    // Explicit skip, never a silent pass. The board route lands in Phase 2.
    console.log(
      '[board-chunk] SKIPPED — no board entry points exist yet.\n' +
        `[board-chunk] Watching for: ${BOARD_ENTRIES.join(', ')}`,
    )
    process.exit(0)
  }

  const violations = scan(present, budgets.bannedInBoardChunk)

  if (violations.length > 0) {
    console.error(
      '[board-chunk] BANNED ANIMATION LIBRARY IN THE BOARD CHUNK — C-3, R-PERF-021\n',
    )
    for (const v of violations) {
      console.error(`  ${v.specifier}`)
      console.error(`    in ${v.file}`)
      if (v.chain.length > 1) console.error(`    via ${v.chain.join('\n        → ')}`)
    }
    console.error(
      '\n  Framer Motion is permitted only in the marketing and dashboard chunks.',
    )
    console.error(
      '  GSAP is not a dependency of this project. See RULES.md §2.3 conflict C-3.',
    )
    process.exit(1)
  }

  console.log(
    `[board-chunk] clean — scanned ${present.length} entry point(s), no banned imports`,
  )
}
