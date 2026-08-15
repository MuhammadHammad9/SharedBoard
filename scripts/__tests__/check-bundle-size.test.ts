import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkSizes,
  classify,
  collectJsFiles,
  type BudgetsFile,
} from '../check-bundle-size.js'

/**
 * Negative tests for the bundle-size gate (PRD §7.1, R-PERF-020, conflict C-4).
 *
 * The budgets are the reason GSAP was not adopted. If the gate cannot fail,
 * that decision is unenforced.
 */

const budgets: BudgetsFile = {
  bundles: {
    initial: { label: 'Initial JS (gzipped)', maxBytes: 2_000, maxLabel: '2 KB' },
    board: { label: 'Board route chunk (gzipped)', maxBytes: 1_000, maxLabel: '1 KB' },
  },
  bannedInBoardChunk: [],
}

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'coboard-size-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Random-ish content so gzip cannot collapse it to nothing. */
function incompressible(bytes: number): string {
  let s = ''
  let seed = 42
  while (s.length < bytes) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    s += seed.toString(36)
  }
  return s.slice(0, bytes)
}

describe('classify', () => {
  it('routes board-named chunks to the board budget', () => {
    expect(classify('/dist/assets/Board-a1b2c3.js')).toBe('board')
    expect(classify('/dist/assets/board-route.js')).toBe('board')
  })

  it('routes everything else to the initial budget', () => {
    expect(classify('/dist/assets/index-x1.js')).toBe('initial')
    expect(classify('/dist/assets/vendor-react.js')).toBe('initial')
  })

  it('ignores "board" in PARENT DIRECTORIES — regression', () => {
    // This repository lives at .../SharedBoard/. Matching the full path
    // classified every chunk as the board chunk, which silently disabled the
    // initial-bundle budget entirely.
    expect(classify('/home/user/SharedBoard/apps/web/dist/assets/index-a1.js')).toBe(
      'initial',
    )
    expect(classify('/home/user/SharedBoard/apps/web/dist/assets/vendor-react.js')).toBe(
      'initial',
    )
    expect(classify('/home/user/SharedBoard/apps/web/dist/assets/Board-a1.js')).toBe(
      'board',
    )
  })
})

describe('collectJsFiles', () => {
  it('returns an empty list for a missing directory rather than throwing', () => {
    expect(collectJsFiles(join(dir, 'nope'))).toEqual([])
  })
})

describe('checkSizes — the gate must actually fail', () => {
  it('PASSES when both bundles are under budget', () => {
    const d = join(dir, 'under')
    mkdirSync(join(d, 'assets'), { recursive: true })
    writeFileSync(join(d, 'assets', 'index-aaa.js'), 'const a=1\n')
    writeFileSync(join(d, 'assets', 'Board-bbb.js'), 'const b=2\n')

    const r = checkSizes(d, budgets)
    expect(r.ok).toBe(true)
    expect(r.failures).toHaveLength(0)
  })

  it('FAILS when the initial bundle exceeds its budget', () => {
    const d = join(dir, 'over-initial')
    mkdirSync(join(d, 'assets'), { recursive: true })
    writeFileSync(join(d, 'assets', 'index-big.js'), incompressible(20_000))

    const r = checkSizes(d, budgets)
    expect(r.ok).toBe(false)
    expect(r.failures.join(' ')).toContain('Initial JS')
  })

  it('FAILS when the board chunk exceeds its budget', () => {
    const d = join(dir, 'over-board')
    mkdirSync(join(d, 'assets'), { recursive: true })
    writeFileSync(join(d, 'assets', 'Board-big.js'), incompressible(20_000))

    const r = checkSizes(d, budgets)
    expect(r.ok).toBe(false)
    expect(r.failures.join(' ')).toContain('Board route chunk')
  })

  it('sums multiple chunks into the same budget', () => {
    const d = join(dir, 'summed')
    mkdirSync(join(d, 'assets'), { recursive: true })
    writeFileSync(join(d, 'assets', 'index-a.js'), incompressible(1_500))
    writeFileSync(join(d, 'assets', 'vendor-b.js'), incompressible(1_500))

    const r = checkSizes(d, budgets)
    // Each alone is under 2 KB gzipped; together they must breach it.
    expect(r.totals.initial).toBeGreaterThan(budgets.bundles.initial!.maxBytes)
    expect(r.ok).toBe(false)
  })
})
