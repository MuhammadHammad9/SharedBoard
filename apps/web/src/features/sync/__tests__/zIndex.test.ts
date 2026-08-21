import { describe, expect, it } from 'vitest'
import type { BoardObject, ObjectId } from '@coboard/shared'
import {
  keyAfterTop,
  keysAfter,
  keysAfterTop,
  keysBefore,
  keysBeforeBottom,
} from '../../canvas/geometry/zIndex.js'

/**
 * Fractional z-indexing — TRD §6.4, decision D-8, FR-CANVAS-016.
 *
 * The property under test is always the same one: a generated key sorts
 * strictly between its neighbours, so ONE object moves and nothing else has to
 * be renumbered. That is the entire argument for fractional keys over
 * integers, and it is what stops "bring forward" from becoming 5,000 ops.
 */

function board(keys: string[]): {
  objects: Map<ObjectId, BoardObject>
  sortedIds: ObjectId[]
} {
  const objects = new Map<ObjectId, BoardObject>()
  const sortedIds: ObjectId[] = []
  keys.forEach((zIndex, i) => {
    const id = `object-${i}` as ObjectId
    objects.set(id, { id, zIndex } as BoardObject)
    sortedIds.push(id)
  })
  return { objects, sortedIds }
}

const sorted = (keys: string[]) => [...keys].sort()

describe('key generation', () => {
  it('places a new object above everything', () => {
    const { objects, sortedIds } = board(['a0', 'a1'])
    const key = keyAfterTop(objects, sortedIds)
    expect(key > 'a1').toBe(true)
  })

  it('works on an empty board', () => {
    const { objects, sortedIds } = board([])
    expect(keyAfterTop(objects, sortedIds)).toEqual(expect.any(String))
  })

  it('generates N keys above the top, in order', () => {
    const { objects, sortedIds } = board(['a0'])
    const keys = keysAfterTop(objects, sortedIds, 3)
    expect(keys).toHaveLength(3)
    expect(sorted(keys)).toEqual(keys)
    expect(keys[0]! > 'a0').toBe(true)
  })

  it('generates N keys below the bottom, in order', () => {
    const { objects, sortedIds } = board(['a5'])
    const keys = keysBeforeBottom(objects, sortedIds, 2)
    expect(sorted(keys)).toEqual(keys)
    expect(keys[1]! < 'a5').toBe(true)
  })
})

describe('inserting BETWEEN — the reason for fractional keys', () => {
  it('places a key strictly between two neighbours', () => {
    const { objects, sortedIds } = board(['a0', 'a1', 'a2'])
    // Just above index 1, i.e. between 'a1' and 'a2'.
    const [key] = keysAfter(objects, sortedIds, 1, 1)

    expect(key! > 'a1').toBe(true)
    expect(key! < 'a2').toBe(true)
  })

  it('places a key strictly below its neighbour', () => {
    const { objects, sortedIds } = board(['a0', 'a1', 'a2'])
    const [key] = keysBefore(objects, sortedIds, 1, 1)

    expect(key! > 'a0').toBe(true)
    expect(key! < 'a1').toBe(true)
  })

  it('fits several keys into the same gap without touching anything else', () => {
    const { objects, sortedIds } = board(['a0', 'a1'])
    const keys = keysAfter(objects, sortedIds, 0, 5)

    // Five objects moved between two neighbours is five ops. The integer
    // version renumbers everything above the insertion point.
    expect(keys).toHaveLength(5)
    expect(sorted(keys)).toEqual(keys)
    for (const key of keys) {
      expect(key > 'a0').toBe(true)
      expect(key < 'a1').toBe(true)
    }
  })

  it('keeps subdividing the same gap — no exhaustion', () => {
    let lower = 'a0'
    const upper = 'a1'
    // Twenty successive "bring forward" into the same slot. An implementation
    // that ran out of room here would fail silently after a few reorders.
    for (let i = 0; i < 20; i++) {
      const { objects, sortedIds } = board([lower, upper])
      const [key] = keysAfter(objects, sortedIds, 0, 1)
      expect(key! > lower).toBe(true)
      expect(key! < upper).toBe(true)
      lower = key!
    }
  })
})

describe('the Phase 1-8 key format still sorts', () => {
  it('interleaves with fractional keys, so no migration is needed', () => {
    // The committed stress fixture and every object created before Phase 9
    // use `a` + six base-36 digits. Both formats are just strings compared
    // lexicographically; rewriting 10,000 zIndex values to change nothing
    // anyone can see would be 10,000 ops for no reason.
    const { objects, sortedIds } = board(['a000001', 'a000002'])
    const [key] = keysAfter(objects, sortedIds, 0, 1)

    expect(key! > 'a000001').toBe(true)
    expect(key! < 'a000002').toBe(true)
  })

  it('puts a new object above a fixture-format board', () => {
    const { objects, sortedIds } = board(['a000001', 'a009999'])
    expect(keyAfterTop(objects, sortedIds) > 'a009999').toBe(true)
  })
})
