import { describe, expect, it } from 'vitest'
import type { BoardObject, ObjectId } from '@coboard/shared'
import { boardStore, objectsInZOrder } from '../../../stores/boardStore.js'
import {
  compareZ,
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

describe('tied keys — concurrent creates', () => {
  const obj = (id: string, zIndex: string) =>
    ({
      id,
      type: 'rect',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      rotation: 0,
      zIndex,
      opacity: 1,
      createdBy: 't',
      createdAt: 0,
      updatedAt: 0,
      stroke: '#18181B',
      strokeWidth: 2,
      fill: 'none',
    }) as unknown as BoardObject

  it('orders a tie by id, whatever order the objects arrive in', () => {
    const a = obj('aaaaaaaa-0000-4000-8000-000000000000', 'a1')
    const b = obj('bbbbbbbb-0000-4000-8000-000000000000', 'a1')
    const base = obj('00000000-0000-4000-8000-000000000000', 'a0')

    boardStore.getState().loadObjects([base])
    boardStore.getState().addObject(b)
    boardStore.getState().addObject(a)
    const one = objectsInZOrder().map(o => o.id)

    boardStore.getState().loadObjects([base])
    boardStore.getState().addObject(a)
    boardStore.getState().addObject(b)
    const two = objectsInZOrder().map(o => o.id)

    expect(one).toEqual(two)
    expect(one).toEqual([base.id, a.id, b.id])

    // The remote path and the snapshot path agree with the local one.
    boardStore.getState().loadObjects([base])
    boardStore.getState().applyOps([
      { id: 'o1', type: 'CREATE', objectId: b.id, payload: b },
      { id: 'o2', type: 'CREATE', objectId: a.id, payload: a },
    ] as never)
    expect(objectsInZOrder().map(o => o.id)).toEqual(one)
    boardStore.getState().loadObjects([b, base, a])
    expect(objectsInZOrder().map(o => o.id)).toEqual(one)
    boardStore.getState().reorder()
    expect(objectsInZOrder().map(o => o.id)).toEqual(one)
  })

  it('compareZ breaks a tie by id', () => {
    expect(
      compareZ({ id: 'a', zIndex: 'a1' } as never, { id: 'b', zIndex: 'a1' } as never),
    ).toBe(-1)
    expect(
      compareZ({ id: 'b', zIndex: 'a0' } as never, { id: 'a', zIndex: 'a1' } as never),
    ).toBe(-1)
  })

  it('bring forward beside a tie skips to the next distinct key instead of throwing', () => {
    const { objects, sortedIds } = board(['a0', 'a1', 'a1', 'a2'])
    const keys = keysAfter(objects, sortedIds, 1, 1)
    expect(keys[0]! > 'a1' && keys[0]! < 'a2').toBe(true)
    // At the top of a tie, with nothing above.
    const top = board(['a0', 'a1', 'a1'])
    expect(keysAfter(top.objects, top.sortedIds, 1, 1)[0]! > 'a1').toBe(true)
  })

  it('send backward beside a tie skips to the next distinct key instead of throwing', () => {
    const { objects, sortedIds } = board(['a0', 'a1', 'a1', 'a2'])
    const keys = keysBefore(objects, sortedIds, 2, 1)
    expect(keys[0]! < 'a1' && keys[0]! > 'a0').toBe(true)
    const bottom = board(['a1', 'a1', 'a2'])
    expect(keysBefore(bottom.objects, bottom.sortedIds, 1, 1)[0]! < 'a1').toBe(true)
  })
})
