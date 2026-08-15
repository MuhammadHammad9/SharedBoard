import { describe, expect, it } from 'vitest'
import {
  MIN_OBJECT_SIZE,
  strokeBounds,
  type BoardObject,
  type StrokeObject,
} from '@coboard/shared'
import {
  applyBoxTransform,
  applyRotation,
  resizeBox,
  rotationFor,
  translateObject,
} from '../geometry/transformSelection.js'
import { anchorFor, handleAt, handleCentre, selectionBounds } from '../geometry/bounds.js'

/**
 * Resize, rotate and translate maths — FR-CANVAS-011/012/013, FLOWS §8.2.3.
 *
 * Pure functions, exhaustively tested. The Shift/Alt/clamp interactions are
 * where resize bugs live and they are almost impossible to pin down by driving
 * a pointer.
 */

const BOX = { x: 0, y: 0, width: 100, height: 50 }
const NO_MODS = { aspect: false, fromCentre: false }

let seq = 0
function obj(over: Partial<BoardObject> = {}): BoardObject {
  seq++
  return {
    id: `${seq}`.padStart(8, '0') + '-0000-4000-8000-000000000000',
    type: 'rect',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
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

describe('resizeBox — corner handles', () => {
  it('holds the opposite corner still', () => {
    const out = resizeBox(BOX, 'se', 200, 100, NO_MODS)
    // Dragging 'se' pivots on 'nw' at (0, 0).
    expect(out).toEqual({ x: 0, y: 0, width: 200, height: 100 })
  })

  it('grows up and left when dragging nw', () => {
    const out = resizeBox(BOX, 'nw', -50, -50, NO_MODS)
    // Anchor is 'se' at (100, 50).
    expect(out).toEqual({ x: -50, y: -50, width: 150, height: 100 })
  })

  it('never flips or produces negative dimensions', () => {
    // Drag 'se' far past the 'nw' anchor. A naive implementation returns a
    // negative width here, which fails Zod validation the moment it reaches
    // the server in Phase 9.
    const out = resizeBox(BOX, 'se', -500, -500, NO_MODS)
    expect(out.width).toBeGreaterThan(0)
    expect(out.height).toBeGreaterThan(0)
  })
})

describe('resizeBox — edge handles resize ONE axis', () => {
  it('east moves width only', () => {
    const out = resizeBox(BOX, 'e', 250, 999, NO_MODS)
    expect(out.width).toBe(250)
    expect(out.height).toBe(BOX.height)
    expect(out.y).toBe(BOX.y)
  })

  it('south moves height only', () => {
    const out = resizeBox(BOX, 's', 999, 300, NO_MODS)
    expect(out.height).toBe(300)
    expect(out.width).toBe(BOX.width)
    expect(out.x).toBe(BOX.x)
  })
})

describe('resizeBox — Shift preserves the aspect ratio EXACTLY', () => {
  it('holds 2:1 on a corner drag', () => {
    const out = resizeBox(BOX, 'se', 300, 60, { aspect: true, fromCentre: false })
    expect(out.width / out.height).toBeCloseTo(BOX.width / BOX.height, 10)
  })

  it('holds the ratio when the drag is dominated by the other axis', () => {
    const out = resizeBox(BOX, 'se', 60, 400, { aspect: true, fromCentre: false })
    expect(out.width / out.height).toBeCloseTo(2, 10)
  })

  it('derives the second axis on an edge handle', () => {
    const out = resizeBox(BOX, 'e', 400, 0, { aspect: true, fromCentre: false })
    expect(out.width).toBe(400)
    expect(out.height).toBeCloseTo(200, 10)
  })
})

describe('resizeBox — Alt resizes about the CENTRE', () => {
  it('keeps the centre fixed', () => {
    const before = { x: BOX.x + BOX.width / 2, y: BOX.y + BOX.height / 2 }
    const out = resizeBox(BOX, 'se', 200, 120, { aspect: false, fromCentre: true })
    expect(out.x + out.width / 2).toBeCloseTo(before.x, 10)
    expect(out.y + out.height / 2).toBeCloseTo(before.y, 10)
  })

  it('grows both ways, so the box is twice the pointer distance', () => {
    // Centre is (50, 25). Pointer 150 units right of it → 300 wide.
    const out = resizeBox(BOX, 'se', 200, 25, { aspect: false, fromCentre: true })
    expect(out.width).toBeCloseTo(300, 10)
  })

  it('combines with Shift', () => {
    const centre = { x: 50, y: 25 }
    const out = resizeBox(BOX, 'se', 250, 40, { aspect: true, fromCentre: true })
    expect(out.width / out.height).toBeCloseTo(2, 10)
    expect(out.x + out.width / 2).toBeCloseTo(centre.x, 10)
    expect(out.y + out.height / 2).toBeCloseTo(centre.y, 10)
  })
})

describe('resizeBox — the 8×8 floor', () => {
  it('clamps both axes at MIN_OBJECT_SIZE', () => {
    const out = resizeBox(BOX, 'se', 0.5, 0.5, NO_MODS)
    expect(out.width).toBe(MIN_OBJECT_SIZE)
    expect(out.height).toBe(MIN_OBJECT_SIZE)
  })

  it('clamps when resizing from the centre too', () => {
    const out = resizeBox(BOX, 'se', 50, 25, { aspect: false, fromCentre: true })
    expect(out.width).toBeGreaterThanOrEqual(MIN_OBJECT_SIZE)
    expect(out.height).toBeGreaterThanOrEqual(MIN_OBJECT_SIZE)
  })

  it('leaves the rotate handle alone', () => {
    expect(resizeBox(BOX, 'rotate', 999, 999, NO_MODS)).toEqual(BOX)
  })
})

describe('applyBoxTransform', () => {
  it('keeps each object in the same relative position', () => {
    const o = obj({ x: 50, y: 25, width: 50, height: 25 })
    // Double the box.
    const out = applyBoxTransform(o, BOX, { x: 0, y: 0, width: 200, height: 100 })
    expect(out.x).toBe(100)
    expect(out.y).toBe(50)
    expect(out.width).toBe(100)
    expect(out.height).toBe(50)
  })

  it('scales a stroke’s POINT GEOMETRY, not just its box — FR-CANVAS-012', () => {
    const points = [0, 0, 0.5, 50, 25, 0.9, 100, 50, 0.3]
    const box = strokeBounds(points, 0)
    const s = obj({
      type: 'stroke',
      points,
      color: '#18181B',
      strokeWidth: 0,
      simplified: true,
      ...box,
    } as Partial<BoardObject>) as StrokeObject

    const doubled = applyBoxTransform(s, box, {
      x: box.x,
      y: box.y,
      width: box.width * 2,
      height: box.height * 2,
    }) as StrokeObject

    // Scaling only the bounding box would leave the drawn path unchanged
    // inside a box that no longer matches it.
    expect(doubled.points[3]).toBeCloseTo(100, 6)
    expect(doubled.points[4]).toBeCloseTo(50, 6)
    // Pressure is not geometry and must ride through untouched.
    expect(doubled.points[5]).toBe(0.9)
  })

  it('survives a zero-width source box without dividing by zero', () => {
    const o = obj({ x: 0, y: 0, width: 0, height: 10 })
    const out = applyBoxTransform(o, { x: 0, y: 0, width: 0, height: 10 }, BOX)
    expect(Number.isFinite(out.x)).toBe(true)
    expect(Number.isFinite(out.width)).toBe(true)
  })
})

describe('rotationFor — FR-CANVAS-013', () => {
  it('reports 0° straight up, matching the handle’s resting position', () => {
    expect(rotationFor(0, 0, 0, -100, false)).toBeCloseTo(0, 6)
  })

  it('advances clockwise', () => {
    expect(rotationFor(0, 0, 100, 0, false)).toBeCloseTo(90, 6)
    expect(rotationFor(0, 0, 0, 100, false)).toBeCloseTo(180, 6)
    expect(rotationFor(0, 0, -100, 0, false)).toBeCloseTo(270, 6)
  })

  it('normalises to [0, 360) — never negative, never 360', () => {
    for (const [x, y] of [
      [-1, -100],
      [1, -100],
      [0, -1],
    ]) {
      const deg = rotationFor(0, 0, x!, y!, false)
      expect(deg).toBeGreaterThanOrEqual(0)
      expect(deg).toBeLessThan(360)
    }
  })

  it('Shift snaps to 15° increments', () => {
    // 100° raw snaps to 105°, the nearest multiple of 15.
    const snapped = rotationFor(0, 0, Math.sin(1.745), -Math.cos(1.745), true)
    expect(snapped % 15).toBeCloseTo(0, 6)

    for (const angle of [7, 22, 44, 91, 179, 271, 359]) {
      const rad = (angle * Math.PI) / 180
      const out = rotationFor(0, 0, Math.sin(rad), -Math.cos(rad), true)
      expect(out % 15).toBeCloseTo(0, 6)
    }
  })
})

describe('applyRotation', () => {
  it('spins a single object in place', () => {
    const o = obj({ x: 0, y: 0, width: 100, height: 50 })
    const out = applyRotation(o, 50, 25, 30)
    expect(out.rotation).toBeCloseTo(30, 6)
    // Its centre is the pivot, so it does not travel.
    expect(out.x).toBeCloseTo(0, 6)
    expect(out.y).toBeCloseTo(0, 6)
  })

  it('ORBITS an off-centre object, like a rigid sheet', () => {
    const o = obj({ x: 100, y: 0, width: 10, height: 10 })
    // Rotate 180° about the origin: the object lands opposite.
    const out = applyRotation(o, 0, 0, 180)
    expect(out.x + out.width / 2).toBeCloseTo(-105, 6)
    expect(out.rotation).toBeCloseTo(180, 6)
  })

  it('normalises past 360', () => {
    const o = obj({ rotation: 350 })
    expect(applyRotation(o, 0, 0, 20).rotation).toBeCloseTo(10, 6)
  })
})

describe('translateObject', () => {
  it('moves a plain object', () => {
    const out = translateObject(obj({ x: 10, y: 20 }), 5, -5)
    expect(out.x).toBe(15)
    expect(out.y).toBe(15)
  })

  it('moves a stroke’s points along with its box', () => {
    const points = [0, 0, 0.5, 10, 10, 0.5]
    const s = obj({
      type: 'stroke',
      points,
      color: '#000000',
      strokeWidth: 1,
      simplified: true,
    } as Partial<BoardObject>) as StrokeObject
    const out = translateObject(s, 100, 50) as StrokeObject
    expect(out.points).toEqual([100, 50, 0.5, 110, 60, 0.5])
  })

  it('clamps to the ±1,000,000 coordinate bound — R-COORD-003', () => {
    const out = translateObject(obj({ x: 999_000 }), 100_000, 0)
    expect(out.x).toBe(1_000_000)
  })
})

describe('handle geometry — R-CANVAS-043, FLOWS E-11', () => {
  it('places the eight handles on the box', () => {
    expect(handleCentre(BOX, 'nw', 1)).toEqual({ x: 0, y: 0 })
    expect(handleCentre(BOX, 'se', 1)).toEqual({ x: 100, y: 50 })
    expect(handleCentre(BOX, 'n', 1)).toEqual({ x: 50, y: 0 })
    expect(handleCentre(BOX, 'w', 1)).toEqual({ x: 0, y: 25 })
  })

  it('keeps the rotate handle a CONSTANT screen distance above the box', () => {
    // The offset divides by zoom, so it is 24 screen px at every zoom level.
    const at1 = BOX.y - handleCentre(BOX, 'rotate', 1).y
    const at5 = BOX.y - handleCentre(BOX, 'rotate', 5).y
    expect(at1 * 1).toBeCloseTo(at5 * 5, 6)
  })

  it('anchors each handle on its opposite', () => {
    expect(anchorFor(BOX, 'se')).toEqual({ x: 0, y: 0 })
    expect(anchorFor(BOX, 'nw')).toEqual({ x: 100, y: 50 })
    expect(anchorFor(BOX, 'e')).toEqual({ x: 0, y: 25 })
  })

  it('grows the hit target as the user zooms OUT, in canvas units', () => {
    // At 500% the 8 px target is 1.6 canvas units; at 10% it is 80. Same
    // physical size under the finger either way — E-11's requirement.
    expect(handleAt(3, 3, BOX, 0.1)).toBe('nw')
    expect(handleAt(3, 3, BOX, 5)).toBeNull()
    expect(handleAt(0.5, 0.5, BOX, 5)).toBe('nw')
  })

  it('uses a 44 px target on a coarse pointer', () => {
    // A finger cannot aim at 8 px. Both Apple and Google land near 44.
    expect(handleAt(20, 20, BOX, 1, false)).toBeNull()
    expect(handleAt(20, 20, BOX, 1, true)).toBe('nw')
  })

  it('returns null well away from every handle', () => {
    expect(handleAt(50, 25, BOX, 1)).toBeNull()
  })
})

describe('selectionBounds', () => {
  it('is null for an empty selection', () => {
    expect(selectionBounds([])).toBeNull()
  })

  it('unions several objects', () => {
    const a = obj({ x: 0, y: 0, width: 10, height: 10 })
    const b = obj({ x: 90, y: 40, width: 10, height: 10 })
    expect(selectionBounds([a, b])).toEqual({ x: 0, y: 0, width: 100, height: 50 })
  })

  it('encloses a ROTATED object’s true visual extent', () => {
    const spun = obj({ x: 0, y: 0, width: 100, height: 0, rotation: 90 })
    const box = selectionBounds([spun])!
    // Rotated 90°, a 100-wide flat object becomes 100 tall.
    expect(box.height).toBeCloseTo(100, 6)
    expect(box.width).toBeCloseTo(0, 6)
  })
})
