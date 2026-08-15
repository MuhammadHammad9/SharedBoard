import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractImports, isBanned, scan } from '../check-board-chunk-imports.js'

/**
 * Negative tests for the board-chunk import gate.
 *
 * A gate that has never failed is a gate nobody has tested. These prove it
 * fails on the thing it exists to catch (C-3, R-PERF-021), including when the
 * banned import is TRANSITIVE — reached through an innocuous-looking component.
 */

const BANNED = ['framer-motion', 'motion/react', 'motion', 'gsap', '@gsap/react']

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'coboard-chunk-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('extractImports', () => {
  it('finds static, side-effect, dynamic and re-export specifiers', () => {
    const src = `
      import React from 'react'
      import { motion } from 'framer-motion'
      import './styles.css'
      const lazy = await import('gsap')
      export { thing } from './thing.js'
      const req = require('@gsap/react')
    `
    const found = extractImports(src)
    expect(found).toContain('react')
    expect(found).toContain('framer-motion')
    expect(found).toContain('./styles.css')
    expect(found).toContain('gsap')
    expect(found).toContain('./thing.js')
    expect(found).toContain('@gsap/react')
  })
})

describe('isBanned', () => {
  it('matches exact names and subpaths', () => {
    expect(isBanned('framer-motion', BANNED)).toBe(true)
    expect(isBanned('motion/react', BANNED)).toBe(true)
    expect(isBanned('gsap/ScrollTrigger', BANNED)).toBe(true)
  })

  it('does not match unrelated packages that merely share a prefix', () => {
    expect(isBanned('react', BANNED)).toBe(false)
    expect(isBanned('zustand', BANNED)).toBe(false)
    expect(isBanned('framer-motion-utils-lookalike', BANNED)).toBe(false)
  })
})

describe('scan — the gate must actually fail', () => {
  it('FAILS on a direct banned import from a board entry', () => {
    const root = join(dir, 'direct')
    mkdirSync(root, { recursive: true })
    writeFileSync(
      join(root, 'Board.tsx'),
      `import { motion } from 'framer-motion'\nexport default function Board() { return null }\n`,
    )

    const violations = scan([join(root, 'Board.tsx')], BANNED)
    expect(violations).toHaveLength(1)
    expect(violations[0]!.specifier).toBe('framer-motion')
  })

  it('FAILS on a TRANSITIVE banned import two hops deep', () => {
    const root = join(dir, 'transitive')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'Board.tsx'), `import { Toolbar } from './Toolbar.js'\n`)
    writeFileSync(join(root, 'Toolbar.tsx'), `import { Fancy } from './Fancy.js'\n`)
    writeFileSync(join(root, 'Fancy.tsx'), `import { animate } from 'gsap'\n`)

    const violations = scan([join(root, 'Board.tsx')], BANNED)
    expect(violations).toHaveLength(1)
    expect(violations[0]!.specifier).toBe('gsap')
    // The chain is what makes the failure debuggable.
    expect(violations[0]!.chain.length).toBeGreaterThan(1)
  })

  it('PASSES on a clean board graph', () => {
    const root = join(dir, 'clean')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'Board.tsx'), `import { Toolbar } from './Toolbar.js'\n`)
    writeFileSync(
      join(root, 'Toolbar.tsx'),
      `import { Pencil } from '@phosphor-icons/react'\nimport { useStore } from 'zustand'\n`,
    )

    expect(scan([join(root, 'Board.tsx')], BANNED)).toHaveLength(0)
  })

  it('returns no violations for a non-existent entry, so Phase 1 can skip cleanly', () => {
    expect(scan([join(dir, 'does-not-exist')], BANNED)).toHaveLength(0)
  })
})
