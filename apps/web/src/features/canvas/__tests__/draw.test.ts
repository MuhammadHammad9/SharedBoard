import { beforeEach, describe, expect, it, vi } from 'vitest'
import { COORD_MAX, STROKE_POINT_STRIDE } from '@coboard/shared'
import { boardStore } from '../../../stores/boardStore.js'
import {
  appendPoint,
  beginDraw,
  cancelDraw,
  commitDraw,
} from '../interaction/handlers/draw.js'
import { beginPan } from '../interaction/handlers/pan.js'
import { canTransition } from '../interaction/machine.js'

/**
 * Drawing — FR-CANVAS-005, FLOWS §8.2.1, §15.1.
 *
 * These drive the real store rather than a mock, because the bugs worth
 * catching here are exactly the interactions between the handler, the machine
 * and the store — a mock would agree with whatever the handler did.
 */

/** The node environment has no crypto.randomUUID in every runtime. */
let uuidCounter = 0
beforeEach(() => {
  uuidCounter = 0
  vi.stubGlobal('crypto', {
    randomUUID: () =>
      `${(++uuidCounter).toString().padStart(8, '0')}-0000-4000-8000-000000000000`,
  })

  boardStore.setState({
    objects: new Map(),
    objectsVersion: 0,
    sortedIds: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    activeTool: 'pen',
    pen: { color: '#EF4444', strokeWidth: 4, opacity: 0.8 },
    interaction: { type: 'IDLE' },
    draft: null,
    draftVersion: 0,
  })
})

/** Drag a straight-ish path and release. Returns the committed object. */
function drawPath(points: readonly (readonly [number, number])[]) {
  const [first, ...rest] = points
  beginDraw(1, first![0], first![1], 0.5)
  for (const [x, y] of rest) appendPoint(x, y, 0.5)
  return commitDraw(null)
}

describe('beginDraw', () => {
  it('enters DRAWING and seeds a draft with the first point', () => {
    expect(beginDraw(1, 100, 50, 0.5)).toBe(true)

    const s = boardStore.getState()
    expect(s.interaction.type).toBe('DRAWING')
    expect(s.draft?.points).toEqual([100, 50, 0.5])
    // The draft inherits the CURRENT pen settings, frozen at pointerdown —
    // changing colour mid-stroke must not recolour the stroke in progress.
    expect(s.draft).toMatchObject({ color: '#EF4444', strokeWidth: 4, opacity: 0.8 })
  })

  it('uses the op id as the object id — R-SYNC-014 idempotency', () => {
    beginDraw(1, 0, 0, 0.5)
    const s = boardStore.getState()
    expect(s.interaction.type === 'DRAWING' && s.interaction.opId).toBe(s.draft?.id)
  })

  it('converts screen to canvas coordinates through the viewport', () => {
    boardStore.setState({ viewport: { x: 100, y: 50, zoom: 2 } })
    beginDraw(1, 300, 250, 0.5)
    // (300 - 100) / 2 = 100 ; (250 - 50) / 2 = 100
    expect(boardStore.getState().draft?.points.slice(0, 2)).toEqual([100, 100])
  })

  it('refuses to start while another interaction owns the pointer', () => {
    beginPan(1, 0, 0)
    expect(beginDraw(2, 10, 10, 0.5)).toBe(false)
    expect(boardStore.getState().interaction.type).toBe('PANNING')
  })
})

describe('appendPoint', () => {
  it('appends stride-3 samples and bumps draftVersion', () => {
    beginDraw(1, 0, 0, 0.5)
    const v0 = boardStore.getState().draftVersion

    appendPoint(10, 10, 0.7)
    appendPoint(20, 30, 0.9)

    const s = boardStore.getState()
    expect(s.draft?.points).toEqual([0, 0, 0.5, 10, 10, 0.7, 20, 30, 0.9])
    // R-STATE-002: the array was mutated in place; the counter is what tells
    // the renderer to repaint.
    expect(s.draftVersion).toBeGreaterThan(v0)
  })

  it('normalises a zero pressure to the mouse default — FR-CANVAS-005 [P1]', () => {
    // Mice report 0 or 0.5 depending on the browser. A stored 0 would mean
    // "no pressure at all", which is not what the hardware is saying.
    beginDraw(1, 0, 0, 0)
    appendPoint(10, 10, 0)
    expect(boardStore.getState().draft?.points).toEqual([0, 0, 0.5, 10, 10, 0.5])
  })

  it('keeps a genuine stylus pressure and clamps above 1', () => {
    beginDraw(1, 0, 0, 0.25)
    appendPoint(1, 1, 1.4)
    expect(boardStore.getState().draft?.points).toEqual([0, 0, 0.25, 1, 1, 1])
  })

  it('is inert when no stroke is in progress', () => {
    appendPoint(10, 10, 0.5)
    expect(boardStore.getState().draft).toBeNull()
  })

  it('clamps coordinates to the ±1,000,000 bound — R-COORD-003', () => {
    beginDraw(1, 0, 0, 0.5)
    appendPoint(9_999_999, -9_999_999, 0.5)
    const pts = boardStore.getState().draft!.points
    expect(pts[3]).toBe(COORD_MAX)
    expect(pts[4]).toBe(-COORD_MAX)
  })

  it('does NOT simplify during the stroke — R-CANVAS-032', () => {
    beginDraw(1, 0, 0, 0.5)
    // Ten perfectly collinear points. RDP would reduce these to two; running
    // it here would be O(n²) work discarded on the next move.
    for (let i = 1; i <= 10; i++) appendPoint(i * 10, i * 10, 0.5)
    expect(boardStore.getState().draft!.points.length / STROKE_POINT_STRIDE).toBe(11)
  })
})

describe('commitDraw', () => {
  it('simplifies once, stores the object, and clears the draft', () => {
    const object = drawPath([
      [0, 0],
      [10, 10],
      [20, 20],
      [30, 30],
      [40, 40],
    ])!

    expect(object).not.toBeNull()
    expect(object.type).toBe('stroke')
    expect(object.simplified).toBe(true)
    // Collinear: RDP keeps only the endpoints.
    expect(object.points).toEqual([0, 0, 0.5, 40, 40, 0.5])

    const s = boardStore.getState()
    // Equal, not identical: addObject re-clamps coordinates on the way in and
    // stores its own copy (R-COORD-003).
    expect(s.objects.get(object.id)).toEqual(object)
    expect(s.sortedIds).toEqual([object.id])
    expect(s.draft).toBeNull()
    expect(s.interaction.type).toBe('IDLE')
  })

  it('derives a bounding box that accounts for stroke width', () => {
    const object = drawPath([
      [0, 0],
      [50, 0],
      [100, 60],
    ])!
    // strokeWidth 4 → 2 units of overhang on each side.
    expect(object.x).toBe(-2)
    expect(object.y).toBe(-2)
    expect(object.width).toBe(104)
    expect(object.height).toBe(64)
  })

  it('carries the pen settings onto the object', () => {
    const object = drawPath([
      [0, 0],
      [10, 10],
    ])!
    expect(object).toMatchObject({ color: '#EF4444', strokeWidth: 4, opacity: 0.8 })
  })

  it('discards a click that never became a drag', () => {
    beginDraw(1, 30, 30, 0.5)
    expect(commitDraw(null)).toBeNull()

    const s = boardStore.getState()
    // A one-point stroke renders as nothing and can never be selected, so an
    // accidental click must not litter the board with an invisible object.
    expect(s.objects.size).toBe(0)
    expect(s.interaction.type).toBe('IDLE')
    expect(s.draft).toBeNull()
  })

  it('assigns increasing z-index keys so later strokes sit on top', () => {
    const a = drawPath([
      [0, 0],
      [10, 10],
    ])!
    const b = drawPath([
      [0, 0],
      [10, 10],
    ])!
    const c = drawPath([
      [0, 0],
      [10, 10],
    ])!

    expect(a.zIndex < b.zIndex).toBe(true)
    expect(b.zIndex < c.zIndex).toBe(true)
    // The cached order is the paint order — R-CONV-009.
    expect(boardStore.getState().sortedIds).toEqual([a.id, b.id, c.id])
  })

  it('is inert when no stroke is in progress', () => {
    expect(commitDraw(null)).toBeNull()
    expect(boardStore.getState().objects.size).toBe(0)
  })
})

describe('cancelDraw — FLOWS E-09, R-CANVAS-052', () => {
  it('discards the stroke entirely and leaves no trace', () => {
    beginDraw(1, 0, 0, 0.5)
    for (let i = 1; i <= 20; i++) appendPoint(i * 5, i * 3, 0.5)

    cancelDraw(null)

    const s = boardStore.getState()
    expect(s.objects.size).toBe(0)
    expect(s.sortedIds).toEqual([])
    expect(s.draft).toBeNull()
    expect(s.interaction.type).toBe('IDLE')
  })

  it('releases the captured pointer even on the cancel path — R-CANVAS-053', () => {
    const release = vi.fn()
    const element = { releasePointerCapture: release } as unknown as Element

    beginDraw(7, 0, 0, 0.5)
    cancelDraw(element)

    expect(release).toHaveBeenCalledWith(7)
  })

  it('survives a release that throws, rather than stranding the machine', () => {
    const element = {
      releasePointerCapture: () => {
        throw new Error('pointer already gone')
      },
    } as unknown as Element

    beginDraw(1, 0, 0, 0.5)
    expect(() => cancelDraw(element)).not.toThrow()
    expect(boardStore.getState().interaction.type).toBe('IDLE')
  })

  it('is inert when no stroke is in progress', () => {
    cancelDraw(null)
    expect(boardStore.getState().interaction.type).toBe('IDLE')
  })
})

describe('R-CANVAS-051 — PANNING cannot be entered from DRAWING', () => {
  it('is rejected by the machine, now that DRAWING is actually reachable', () => {
    // Phase 2 wrote this guard blind. This is the first test that can reach
    // DRAWING for real and prove it.
    expect(canTransition('DRAWING', 'PANNING')).toBe(false)
  })

  it('holding Space mid-stroke does nothing to the interaction', () => {
    beginDraw(1, 0, 0, 0.5)
    appendPoint(10, 10, 0.5)

    // What useKeyboard's Space handler ultimately attempts.
    expect(beginPan(1, 50, 50)).toBe(false)

    const s = boardStore.getState()
    expect(s.interaction.type).toBe('DRAWING')
    // And the stroke is undisturbed — no lost points, no corrupted state.
    expect(s.draft?.points).toEqual([0, 0, 0.5, 10, 10, 0.5])
  })
})
