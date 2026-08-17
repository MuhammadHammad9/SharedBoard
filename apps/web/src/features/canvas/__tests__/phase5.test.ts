import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MIN_OBJECT_SIZE,
  STICKY_DEFAULT_SIZE,
  type BoardObject,
  type ObjectId,
} from '@coboard/shared'
import { boardStore } from '../../../stores/boardStore.js'
import { shapeBox } from '../interaction/handlers/create.js'
import {
  STICKY_FONT_MAX,
  STICKY_FONT_MIN,
  fitText,
  lineHeightFor,
  wrapText,
} from '../renderer/textMetrics.js'
import { findSnaps, SNAP_THRESHOLD_PX } from '../geometry/alignmentGuides.js'
import { deserialize, rekey, serialize } from '../../../lib/clipboard.js'

/**
 * Phase 5 pure logic — FR-CANVAS-007, 008, 009, 015, 020.
 *
 * Shape constraints, text wrapping and auto-shrink, alignment snapping and
 * clipboard round-tripping. All pure functions, so all exhaustively testable
 * without a canvas or a pointer.
 */

let uuidSeq = 0
beforeEach(() => {
  uuidSeq = 0
  vi.stubGlobal('crypto', {
    randomUUID: () =>
      `${(++uuidSeq).toString().padStart(8, '0')}-0000-4000-8000-000000000000`,
  })
})

/** A width model: every character is 10 units wide at 10 px. */
const measureAt = (size: number) => (s: string) => s.length * size

describe('shapeBox — FR-CANVAS-007 modifiers', () => {
  it('defines a box from two corners, in any drag direction', () => {
    expect(shapeBox('rect', 10, 10, 110, 60, false, false)).toEqual({
      x: 10,
      y: 10,
      width: 100,
      height: 50,
    })
    // Dragging up and left gives the same box.
    expect(shapeBox('rect', 110, 60, 10, 10, false, false)).toEqual({
      x: 10,
      y: 10,
      width: 100,
      height: 50,
    })
  })

  it('Shift constrains a rect to a SQUARE', () => {
    const out = shapeBox('rect', 0, 0, 100, 30, true, false)
    expect(out.width).toBe(out.height)
    // The longer axis wins, so the shape tracks the direction being pulled.
    expect(out.width).toBe(100)
  })

  it('Shift constrains an ellipse to a CIRCLE', () => {
    const out = shapeBox('ellipse', 0, 0, 20, 90, true, false)
    expect(out.width).toBe(out.height)
    expect(out.height).toBe(90)
  })

  it('Shift snaps a line to 45° increments', () => {
    // A nearly-horizontal drag becomes exactly horizontal.
    const flat = shapeBox('line', 0, 0, 100, 8, true, false)
    expect(flat.height).toBeCloseTo(0, 6)

    // A nearly-diagonal drag becomes exactly diagonal.
    const diagonal = shapeBox('line', 0, 0, 100, 92, true, false)
    expect(diagonal.width).toBeCloseTo(diagonal.height, 6)

    // A nearly-vertical drag becomes exactly vertical.
    const upright = shapeBox('arrow', 0, 0, 6, 100, true, false)
    expect(upright.width).toBeCloseTo(0, 6)
  })

  it('Shift preserves the drag LENGTH when snapping a line', () => {
    // Snapping the angle must not also change how long the line is.
    const out = shapeBox('line', 0, 0, 100, 0, true, false)
    expect(Math.hypot(out.width, out.height)).toBeCloseTo(100, 6)
  })

  it('Alt draws from the CENTRE outward', () => {
    const out = shapeBox('rect', 50, 50, 100, 80, false, true)
    // The origin stays the centre; the drag defines the half-extent.
    expect(out.x + out.width / 2).toBeCloseTo(50, 6)
    expect(out.y + out.height / 2).toBeCloseTo(50, 6)
    expect(out.width).toBeCloseTo(100, 6)
    expect(out.height).toBeCloseTo(60, 6)
  })

  it('composes Shift and Alt', () => {
    const out = shapeBox('rect', 50, 50, 150, 70, true, true)
    expect(out.width).toBeCloseTo(out.height, 6)
    expect(out.x + out.width / 2).toBeCloseTo(50, 6)
    expect(out.y + out.height / 2).toBeCloseTo(50, 6)
  })

  it('yields a zero box for a click that never moved', () => {
    const out = shapeBox('rect', 40, 40, 40, 40, false, false)
    expect(out.width).toBe(0)
    expect(out.height).toBe(0)
    // endCreate rejects anything under MIN_OBJECT_SIZE, so this creates nothing.
    expect(Math.min(out.width, out.height)).toBeLessThan(MIN_OBJECT_SIZE)
  })
})

describe('wrapText', () => {
  const measure = measureAt(1)

  it('keeps short text on one line', () => {
    expect(wrapText('hello', 100, measure)).toEqual(['hello'])
  })

  it('breaks on whitespace at the limit', () => {
    // "aaa bbb" is 7 units; a 5-unit line fits only one word.
    expect(wrapText('aaa bbb', 5, measure)).toEqual(['aaa', 'bbb'])
  })

  it('PRESERVES the user’s own newlines', () => {
    // A note with deliberate line breaks must keep them.
    expect(wrapText('a\nb', 100, measure)).toEqual(['a', 'b'])
    // Including blank lines — those are paragraph breaks, not noise.
    expect(wrapText('a\n\nb', 100, measure)).toEqual(['a', '', 'b'])
  })

  it('breaks a single over-long word rather than overflowing', () => {
    // A pasted URL must stay inside the note.
    const out = wrapText('aaaaaaaaaa', 3, measure)
    expect(out.length).toBeGreaterThan(1)
    for (const line of out) expect(line.length).toBeLessThanOrEqual(3)
  })

  it('handles empty text and a zero width without looping forever', () => {
    expect(wrapText('', 100, measure)).toEqual([''])
    expect(wrapText('a b', 0, measure)).toEqual(['a b'])
  })
})

describe('fitText — auto-shrink, FR-CANVAS-008', () => {
  it('uses the LARGEST size whose wrapped text fits the BOX', () => {
    /*
     * "Fits" is a height property, not a one-line property. 'abcd' at 16 px is
     * 64 wide and wraps to two lines in a 50-wide box — but two lines at 16 px
     * is 43 units tall, which fits a 100-tall box comfortably. So 16 is
     * correct, and shrinking further would waste the space available.
     */
    const out = fitText('abcd', 50, 100, measureAt)
    expect(out.fontSize).toBe(STICKY_FONT_MAX)
    expect(out.overflows).toBe(false)
    for (const line of out.lines) {
      expect(line.length * out.fontSize).toBeLessThanOrEqual(50)
    }
    expect(out.lines.length * lineHeightFor(out.fontSize)).toBeLessThanOrEqual(100)
  })

  it('shrinks when the wrapped text is too TALL for the box', () => {
    // Same text, same width, a box too short for two 16 px lines.
    const out = fitText('abcd', 50, 20, measureAt)
    expect(out.fontSize).toBeLessThan(STICKY_FONT_MAX)
    expect(out.lines.length * lineHeightFor(out.fontSize)).toBeLessThanOrEqual(20)
  })

  it('keeps the maximum size when everything fits comfortably', () => {
    const out = fitText('ab', 1000, 1000, measureAt)
    expect(out.fontSize).toBe(STICKY_FONT_MAX)
  })

  it('floors at 10 px and reports overflow — never smaller', () => {
    // Far too much text for the box at any permitted size.
    const out = fitText('word '.repeat(200), 60, 40, measureAt)
    expect(out.fontSize).toBe(STICKY_FONT_MIN)
    expect(out.overflows).toBe(true)
  })

  it('respects the height budget, not just the width', () => {
    const tall = fitText('a b c d e f g h', 20, 1000, measureAt)
    const squat = fitText('a b c d e f g h', 20, 30, measureAt)
    // The same text in a shorter box must end up at a smaller size.
    expect(squat.fontSize).toBeLessThanOrEqual(tall.fontSize)
  })

  it('derives line height from the fitted size', () => {
    expect(lineHeightFor(10)).toBeCloseTo(13.5, 6)
    expect(lineHeightFor(16)).toBeCloseTo(21.6, 6)
  })
})

describe('alignment guides — FR-CANVAS-020', () => {
  const other = (x: number, y: number, w = 100, h = 50): BoardObject =>
    ({
      id: `${x}-${y}` as ObjectId,
      type: 'rect',
      x,
      y,
      width: w,
      height: h,
      rotation: 0,
      zIndex: 'a000001',
      opacity: 1,
      createdBy: 't',
      createdAt: 0,
      updatedAt: 0,
      stroke: '#000000',
      strokeWidth: 1,
      fill: 'none',
    }) as BoardObject

  it('snaps a near-aligned left edge and emits a guide', () => {
    const box = { x: 103, y: 400, width: 100, height: 50 }
    const out = findSnaps(box, [other(100, 0)], 1)
    // Pulled 3 units left, onto the neighbour's edge.
    expect(out.dx).toBeCloseTo(-3, 6)
    expect(out.guides.some(g => g.axis === 'x' && g.position === 100)).toBe(true)
  })

  it('ignores an edge outside the 6-screen-px threshold', () => {
    const box = { x: 130, y: 400, width: 100, height: 50 }
    expect(findSnaps(box, [other(100, 0)], 1)).toMatchObject({ dx: 0, dy: 0, guides: [] })
  })

  it('scales the threshold with ZOOM, because it is in screen pixels', () => {
    // 20 canvas units off. At 10% zoom that is 2 screen px — inside the
    // threshold. At 100% it is 20 screen px — well outside.
    const box = { x: 120, y: 400, width: 100, height: 50 }
    expect(findSnaps(box, [other(100, 0)], 0.1).dx).toBeCloseTo(-20, 6)
    expect(findSnaps(box, [other(100, 0)], 1).dx).toBe(0)

    expect(SNAP_THRESHOLD_PX).toBe(6)
  })

  it('snaps CENTRES, not just edges', () => {
    // Neighbour spans 100..200, centre 150. Our centre at 148 should snap.
    const box = { x: 98, y: 400, width: 100, height: 50 }
    const out = findSnaps(box, [other(100, 0, 100, 50)], 1)
    expect(Math.abs(out.dx)).toBeGreaterThan(0)
  })

  it('picks the CLOSEST candidate, so two neighbours do not fight', () => {
    const box = { x: 104, y: 400, width: 100, height: 50 }
    const out = findSnaps(box, [other(100, 0), other(108, 0)], 1)
    // 108 is 4 away, 100 is 4 away — but only ONE guide per axis is returned.
    expect(out.guides.filter(g => g.axis === 'x')).toHaveLength(1)
  })

  it('is inert when disabled — Ctrl held', () => {
    const box = { x: 101, y: 400, width: 100, height: 50 }
    expect(findSnaps(box, [other(100, 0)], 1, false)).toMatchObject({ dx: 0, dy: 0 })
  })

  it('is inert with no neighbours', () => {
    expect(findSnaps({ x: 0, y: 0, width: 10, height: 10 }, [], 1)).toMatchObject({
      dx: 0,
      dy: 0,
      guides: [],
    })
  })
})

describe('clipboard — FR-CANVAS-015, FLOWS E-06', () => {
  const obj = (over: Partial<BoardObject> = {}): BoardObject =>
    ({
      id: '11111111-1111-4111-8111-111111111111',
      type: 'rect',
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      rotation: 0,
      zIndex: 'a000001',
      opacity: 1,
      createdBy: 'test',
      createdAt: 0,
      updatedAt: 0,
      stroke: '#18181B',
      strokeWidth: 2,
      fill: 'none',
      ...over,
    }) as BoardObject

  it('round-trips through serialize and deserialize', () => {
    const objects = [obj()]
    expect(deserialize(serialize(objects))).toEqual(objects)
  })

  it('ignores foreign clipboard content', () => {
    // Everything read back is untrusted — R-SEC-003, the same discipline the
    // socket boundary gets in Phase 9.
    expect(deserialize('hello world')).toEqual([])
    expect(deserialize('{"kind":"someone-else","objects":[]}')).toEqual([])
    expect(deserialize('[]')).toEqual([])
    expect(deserialize('null')).toEqual([])
    expect(deserialize('{ not json')).toEqual([])
  })

  it('drops only the INVALID members of an otherwise good payload', () => {
    const raw = JSON.stringify({
      kind: 'coboard/objects@1',
      objects: [obj(), { type: 'rect', x: 'not a number' }],
    })
    expect(deserialize(raw)).toHaveLength(1)
  })

  it('rejects a hostile Infinity coordinate — R-SEC-004', () => {
    // JSON cannot carry Infinity, but null round-trips from it and a
    // hand-edited payload can hold anything. An Infinity reaching the renderer
    // blanks the layer for everyone in the room.
    const raw = '{"kind":"coboard/objects@1","objects":[{"type":"rect","x":null}]}'
    expect(deserialize(raw)).toEqual([])
  })

  it('rekey gives every pasted object a NEW id', () => {
    const source = [obj(), obj({ id: '22222222-2222-4222-8222-222222222222' })]
    const pasted = rekey(source, 0, 0, () => 'a000009')

    const sourceIds = new Set(source.map(o => o.id))
    for (const o of pasted) {
      // Reusing an id would make the paste an UPDATE to the original the
      // moment Phase 9 sends it — the copy would move the original instead of
      // appearing beside it.
      expect(sourceIds.has(o.id)).toBe(false)
    }
    expect(new Set(pasted.map(o => o.id)).size).toBe(2)
  })

  it('rekey offsets position and carries stroke points along', () => {
    const s = obj({
      type: 'stroke',
      points: [0, 0, 0.5, 10, 10, 0.9],
      color: '#18181B',
      strokeWidth: 2,
      simplified: true,
    } as Partial<BoardObject>)

    const [pasted] = rekey([s], 100, 50, () => 'a000009') as [
      BoardObject & { points: number[] },
    ]
    expect(pasted.x).toBe(110)
    expect(pasted.y).toBe(70)
    expect(pasted.points).toEqual([100, 50, 0.5, 110, 60, 0.9])
    // Pressure is not a coordinate and must not be offset.
    expect(pasted.points[5]).toBe(0.9)
  })
})

describe('sticky defaults', () => {
  it('places a 200×200 note centred on the click — FR-CANVAS-008', () => {
    expect(STICKY_DEFAULT_SIZE).toBe(200)
    boardStore.setState({
      objects: new Map(),
      sortedIds: [],
      selection: [],
      interaction: { type: 'IDLE' },
      editingTextId: null,
    })
  })
})
