import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * R-UI-052 guard — user-facing copy lives in `lib/strings.ts`, never inline.
 *
 * A static sweep of the chrome directories for the three shapes inlined copy
 * takes: JSX text children, string-literal accessible names / titles /
 * placeholders, and `label:` fields in menu and tool arrays.
 *
 * Escape hatch: a `copy-ok` marker (`// copy-ok`, or `{/* copy-ok *\/}` inside
 * JSX) on any line the match spans. Keep these to genuine non-copy data.
 */

const SRC = fileURLToPath(new URL('../..', import.meta.url))

const DIRS = [
  'components/board',
  'components/dashboard',
  'features/boards',
  'features/sharing',
  'features/export',
  'features/uploads',
]

/** English prose as a JSX text child: `>Load more<`, `>\n  Mixed\n<`. */
const JSX_TEXT = /(?<!=)>\s*[A-Z][a-z]+(?: [A-Za-z'’,.…]+)*\s*<(?=[A-Za-z/])/g

/** `aria-label="Zoom in"` and friends. */
const ATTR_LITERAL =
  /\b(?:aria-label|title|placeholder|label|alt)="[^"{]*[A-Za-z]{2,}[^"]*"/g

/** `aria-label={'Zoom in'}` or `` aria-label={`Zoom ${n}`} `` (text outside `${}`). */
const ATTR_EXPR =
  /\b(?:aria-label|title|placeholder|label|alt)=\{\s*(['`])((?:(?!\1)[^\\]|\\.)*)\1\s*\}/g

/** `{ label: 'Rename', … }` in a menu or tool array. */
const LABEL_PROP = /\blabel:\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g

const hasProse = (literal: string) =>
  /[A-Za-z]{2,}/.test(literal.replace(/\$\{[^}]*\}/g, ''))

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : tsxFiles(path)
    return path.endsWith('.tsx') ? [path] : []
  })
}

/** Blank out comments, preserving offsets and newlines, so prose in docs is ignored. */
function stripComments(source: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ')
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/^\s*\/\/.*$/gm, blank)
}

interface Finding {
  file: string
  line: number
  text: string
}

function scan(file: string): Finding[] {
  const source = readFileSync(file, 'utf8')
  const lines = source.split('\n')
  const code = stripComments(source)
  const findings: Finding[] = []

  const report = (index: number, match: string) => {
    const start = code.slice(0, index).split('\n').length
    const end = start + match.split('\n').length - 1
    const escaped = lines.slice(start - 1, end).some(l => l.includes('copy-ok'))
    if (!escaped) {
      findings.push({
        file: relative(SRC, file),
        line: start,
        text: match.replace(/\s+/g, ' ').trim(),
      })
    }
  }

  for (const m of code.matchAll(JSX_TEXT)) report(m.index, m[0])
  for (const m of code.matchAll(ATTR_LITERAL)) report(m.index, m[0])
  for (const m of code.matchAll(ATTR_EXPR)) if (hasProse(m[2]!)) report(m.index, m[0])
  for (const m of code.matchAll(LABEL_PROP)) if (hasProse(m[2]!)) report(m.index, m[0])

  return findings
}

describe('R-UI-052 — no inline copy in chrome components', () => {
  const files = DIRS.flatMap(dir => tsxFiles(join(SRC, dir)))

  it('finds the directories it is meant to guard', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('every user-facing string is imported from lib/strings.ts', () => {
    const findings = files.flatMap(scan)
    const report = findings.map(f => `${f.file}:${f.line}  ${f.text}`)
    expect(report, 'Move these into lib/strings.ts (or mark `copy-ok`)').toEqual([])
  })

  it('catches the shapes it claims to catch', () => {
    const sample = [
      '<p>\n  Load more\n</p>',
      '<button aria-label="Zoom in" />',
      '<div title={`Zoom ${n} percent`} />',
      "const items = [{ label: 'Rename' }]",
    ]
    const hits = sample.map(
      s =>
        [...s.matchAll(JSX_TEXT)].length +
        [...s.matchAll(ATTR_LITERAL)].length +
        [...s.matchAll(ATTR_EXPR)].filter(m => hasProse(m[2]!)).length +
        [...s.matchAll(LABEL_PROP)].filter(m => hasProse(m[2]!)).length,
    )
    expect(hits).toEqual([1, 1, 1, 1])
    // Composed from strings — not a hit.
    expect(
      [...'<b aria-label={`${actions.remove} ${chip}`} />'.matchAll(ATTR_EXPR)].filter(
        m => hasProse(m[2]!),
      ),
    ).toEqual([])
  })
})
