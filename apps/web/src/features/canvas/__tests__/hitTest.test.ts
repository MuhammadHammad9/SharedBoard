import { describe, expect, it } from 'vitest'
import { strokeBounds, type BoardObject } from '@coboard/shared'
import { hitTest, hitsObject, objectsInRect, toleranceFor } from '../geometry/hitTest.js'

/**
 * Hit testing — TRD §7.7, R-CANVAS-040/041/042, FLOWS E-11.
 *
 * The zoom-tolerance and rotation suites are the ones that matter: both encode
 * behaviour that is invisible at 100% zoom on an unrotated object and broken
 * everywhere else.
 */

let seq = 0
function obj(over: Partial<BoardObject> = {}): BoardObject {
  seq++
  return {
    id: `${seq}`.padStart(8, '0') + '-0000-4000-8000-000000000000',
    type: 'rect',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    zIndex: `a${`${seq}`.padStart(6, '0')}`,
    opacity: 1,
    createdBy: 'test',
    createdAt: 0,
    updatedAt: 0,
    stroke: '#000000',
    strokeWidth: 1,
    fill: '#ffffff',
    ...over,
  } as BoardObject
}

/**
 * A stroke whose bounding box is DERIVED from its points, exactly as
 * `commitDraw` builds it. Hard-coding a mismatched box would defeat the AABB
 * rejection phase and make every stroke test a lie.
 */
const strokeObj = (
  points: number[],
  strokeWidth = 1,
  over: Partial<BoardObject> = {},
) => {
  const box = strokeBounds(points, strokeWidth)
  return obj({
    type: 'stroke',
    points,
    color: '#18181B',
    strokeWidth,
    simplified: true,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    ...over,
  } as Partial<BoardObject>) as BoardObject
}

describe('rect and box-shaped types', () => {
  it('hits inside and misses outside', () => {
    const r = obj({ x: 10, y: 10, width: 50, height: 30 })
    expect(hitsObject(30, 20, r, 1)).toBe(true)
    expect(hitsObject(9, 20, r, 1)).toBe(false)
    expect(hitsObject(30, 45, r, 1)).toBe(false)
  })

  it('treats sticky, image and text as their bounding box', () => {
    for (const type of ['sticky', 'image', 'text'] as const) {
      const o = obj({ type, x: 0, y: 0, width: 40, height: 40 } as Partial<BoardObject>)
      expect(hitsObject(20, 20, o, 1)).toBe(true)
      expect(hitsObject(60, 20, o, 1)).toBe(false)
    }
  })
})

describe('ellipse — (dx/rx)² + (dy/ry)² ≤ 1', () => {
  const e = obj({ type: 'ellipse', x: 0, y: 0, width: 100, height: 50 })

  it('hits the centre and the axis extremes', () => {
    expect(hitsObject(50, 25, e, 1)).toBe(true)
    expect(hitsObject(1, 25, e, 1)).toBe(true)
    expect(hitsObject(99, 25, e, 1)).toBe(true)
  })

  it('MISSES the bounding-box corners, which a rect test would hit', () => {
    // This is the entire reason ellipses get their own test. A box test would
    // report a hit here and the user would select an ellipse by clicking
    // visibly outside it.
    expect(hitsObject(2, 2, e, 1)).toBe(false)
    expect(hitsObject(98, 48, e, 1)).toBe(false)
  })
})

describe('strokes and thin lines — R-CANVAS-041', () => {
  const diagonal = strokeObj([0, 0, 0.5, 100, 100, 0.5], 1)

  it('hits along the path and misses well away from it', () => {
    expect(hitsObject(50, 50, diagonal, 1)).toBe(true)
    expect(hitsObject(50, 90, diagonal, 1)).toBe(false)
  })

  it('a 1 px line is still selectable at 10% zoom — FLOWS E-11', () => {
    /*
     * The headline case. At 10% zoom a 1 px line is a tenth of a screen pixel
     * wide. Without the 4/zoom tolerance the user is asked to click a target
     * that cannot be aimed at; with it, they get 4 screen pixels of slack,
     * which is 40 canvas units down here.
     */
    expect(toleranceFor(0.1)).toBe(40)

    const line = strokeObj([0, 0, 0.5, 1000, 0, 0.5], 1)
    // 30 canvas units off the path — well over a full screen pixel at this
    // zoom, and comfortably inside the tolerance band.
    expect(hitsObject(500, 30, line, 0.1)).toBe(true)
    // Far outside it.
    expect(hitsObject(500, 200, line, 0.1)).toBe(false)
  })

  it('tightens the tolerance as the user zooms IN', () => {
    const line = strokeObj([0, 0, 0.5, 1000, 0, 0.5], 1)
    // At 500% the same 4 screen px is only 0.8 canvas units, so a 30-unit
    // miss that hit at 10% must now miss.
    expect(toleranceFor(5)).toBeCloseTo(0.8, 5)
    expect(hitsObject(500, 30, line, 5)).toBe(false)
    expect(hitsObject(500, 0.5, line, 5)).toBe(true)
  })

  it('accounts for stroke width as well as tolerance', () => {
    const fat = strokeObj([0, 0, 0.5, 100, 0, 0.5], 20)
    // 9 units off the path is inside the painted band (half of 20).
    expect(hitsObject(50, 9, fat, 1)).toBe(true)
    // 40 is outside both the band and the 4-unit tolerance.
    expect(hitsObject(50, 40, fat, 1)).toBe(false)
  })

  it('hits a mid-path segment, not just the endpoints', () => {
    const zigzag = strokeObj([0, 0, 0.5, 50, 100, 0.5, 100, 0, 0.5], 2)
    expect(hitsObject(50, 99, zigzag, 1)).toBe(true)
    expect(hitsObject(50, 20, zigzag, 1)).toBe(false)
  })
})

describe('rotated objects — R-CANVAS-042', () => {
  it('hits a point inside the ROTATED shape', () => {
    // A tall thin rect rotated 90° becomes wide and short. A point that is
    // outside the unrotated box but inside the rotated one must hit.
    const r = obj({ x: 40, y: 0, width: 20, height: 100, rotation: 90 })
    expect(hitsObject(10, 50, r, 1)).toBe(true)
    // ...and one inside the UNROTATED box but outside the rotated one must not.
    expect(hitsObject(50, 10, r, 1)).toBe(false)
  })

  it('a 45° rotation excludes the original corners', () => {
    const r = obj({ x: 0, y: 0, width: 100, height: 100, rotation: 45 })
    expect(hitsObject(50, 50, r, 1)).toBe(true)
    // The unrotated corner is now outside the diamond.
    expect(hitsObject(4, 4, r, 1)).toBe(false)
  })

  it('rotation of 0 short-circuits to the plain box', () => {
    const r = obj({ x: 0, y: 0, width: 10, height: 10, rotation: 0 })
    expect(hitsObject(5, 5, r, 1)).toBe(true)
  })
})

describe('hitTest ordering', () => {
  it('returns the TOPMOST object — reverse z-order', () => {
    const bottom = obj({ x: 0, y: 0, width: 100, height: 100 })
    const top = obj({ x: 0, y: 0, width: 100, height: 100 })
    // The array is in ascending z-order, so `top` was painted last.
    expect(hitTest(50, 50, [bottom, top], 1)?.id).toBe(top.id)
  })

  it('returns null over empty canvas', () => {
    expect(hitTest(500, 500, [obj()], 1)).toBeNull()
    expect(hitTest(0, 0, [], 1)).toBeNull()
  })

  it('falls through a transparent gap to the object beneath', () => {
    // An ellipse's corner is a hole. Something behind it should be reachable.
    const behind = obj({ x: 0, y: 0, width: 100, height: 100 })
    const ellipse = obj({ type: 'ellipse', x: 0, y: 0, width: 100, height: 100 })
    expect(hitTest(3, 3, [behind, ellipse], 1)?.id).toBe(behind.id)
  })
})

describe('objectsInRect — the marquee rule', () => {
  const a = obj({ x: 0, y: 0, width: 20, height: 20 })
  const b = obj({ x: 50, y: 50, width: 20, height: 20 })

  it('selects only objects FULLY contained', () => {
    const all = objectsInRect([a, b], { x: -10, y: -10, width: 200, height: 200 })
    expect(all).toHaveLength(2)

    // Partially overlapping must NOT be selected — otherwise a small object on
    // top of a large one becomes impossible to marquee on its own.
    const partial = objectsInRect([a, b], { x: -10, y: -10, width: 40, height: 40 })
    expect(partial).toEqual([a.id])
  })

  it('measures containment against ROTATED bounds', () => {
    // Rotated 45°, a 20×20 square needs ~28 units of room. A marquee sized for
    // the unrotated square must not catch it.
    const spun = obj({ x: 0, y: 0, width: 20, height: 20, rotation: 45 })
    expect(objectsInRect([spun], { x: -1, y: -1, width: 22, height: 22 })).toEqual([])
    expect(objectsInRect([spun], { x: -10, y: -10, width: 40, height: 40 })).toEqual([
      spun.id,
    ])
  })

  it('returns nothing for an empty marquee', () => {
    expect(objectsInRect([a, b], { x: 0, y: 0, width: 0, height: 0 })).toEqual([])
  })
})
