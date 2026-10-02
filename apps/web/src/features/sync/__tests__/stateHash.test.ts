import { describe, expect, it } from 'vitest'
import type { BoardObject } from '@coboard/shared'
import { canonical, stateHash } from '../stateHash.js'

/**
 * The convergence oracle — R-CONV-011, TRD §6.5.
 *
 * Every property tested here is one whose absence would make two converged
 * clients report different hashes, which would send someone hunting for a
 * sync bug that does not exist.
 */

const rect = (id: string, extra: Record<string, unknown> = {}): BoardObject =>
  ({
    id,
    type: 'rect',
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    rotation: 0,
    zIndex: 'a0',
    style: { stroke: '#18181B', fill: '#FEF08A', strokeWidth: 2 },
    ...extra,
  }) as unknown as BoardObject

describe('stateHash', () => {
  it('does not depend on insertion order', () => {
    const a = rect('a')
    const b = rect('b', { x: 99 })
    const c = rect('c', { zIndex: 'a1' })
    expect(stateHash([a, b, c])).toBe(stateHash([c, a, b]))
  })

  it('does not depend on key order at any depth', () => {
    const one = rect('a')
    const two = {
      style: { strokeWidth: 2, fill: '#FEF08A', stroke: '#18181B' },
      zIndex: 'a0',
      rotation: 0,
      height: 50,
      width: 100,
      y: 20,
      x: 10,
      type: 'rect',
      id: 'a',
    } as unknown as BoardObject
    expect(stateHash([one])).toBe(stateHash([two]))
  })

  it('absorbs float noise below 2 dp', () => {
    const exact = rect('a', { x: 0.3, rotation: 1.57 })
    const noisy = rect('a', { x: 0.1 + 0.2, rotation: 1.5700000000000003 })
    expect(stateHash([exact])).toBe(stateHash([noisy]))
  })

  it('treats -0 and 0 as the same coordinate', () => {
    expect(stateHash([rect('a', { x: -0 })])).toBe(stateHash([rect('a', { x: 0 })]))
    expect(canonical(-0.001)).toBe('0')
  })

  it('treats an undefined key as absent', () => {
    expect(stateHash([rect('a', { text: undefined })])).toBe(stateHash([rect('a')]))
  })

  it('changes when any visible property changes', () => {
    const base = stateHash([rect('a')])
    expect(stateHash([rect('a', { x: 10.01 })])).not.toBe(base)
    expect(stateHash([rect('a', { zIndex: 'a1' })])).not.toBe(base)
    expect(
      stateHash([
        rect('a', { style: { stroke: '#18181B', fill: '#BFDBFE', strokeWidth: 2 } }),
      ]),
    ).not.toBe(base)
    expect(stateHash([rect('a'), rect('b')])).not.toBe(base)
  })

  it('keeps flat point arrays in order — a stroke reversed is a different stroke', () => {
    const fwd = rect('s', { type: 'stroke', points: [0, 0, 0.5, 10, 10, 0.5] })
    const rev = rect('s', { type: 'stroke', points: [10, 10, 0.5, 0, 0, 0.5] })
    expect(stateHash([fwd])).not.toBe(stateHash([rev]))
  })

  it('is a fixed-width hex string, and the empty board has a hash too', () => {
    expect(stateHash([])).toMatch(/^[0-9a-f]{14}$/)
    expect(stateHash([rect('a')])).toMatch(/^[0-9a-f]{14}$/)
  })
})
