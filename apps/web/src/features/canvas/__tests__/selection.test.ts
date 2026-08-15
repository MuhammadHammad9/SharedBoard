import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  strokeBounds,
  type BoardObject,
  type ObjectId,
  type StrokeObject,
} from '@coboard/shared'
import { boardStore } from '../../../stores/boardStore.js'
import {
  CAPTURING_STATES,
  canChangeTool,
  canTransition,
  isCapturing,
  type InteractionType,
} from '../interaction/machine.js'
import {
  beginMarquee,
  endMarquee,
  probe,
  selectObject,
  updateMarquee,
} from '../interaction/handlers/select.js'
import {
  beginDrag,
  beginResize,
  beginRotate,
  cancelDrag,
  cancelResize,
  endDrag,
  nudgeSelection,
  updateDrag,
  updateResize,
} from '../interaction/handlers/transform.js'
import {
  beginErase,
  endErase,
  eraseAt,
  updateEraseHover,
} from '../interaction/handlers/erase.js'
import { beginPan } from '../interaction/handlers/pan.js'
import { beginDraw } from '../interaction/handlers/draw.js'

/**
 * Selection, transform and erase against the REAL store — FR-CANVAS-004,
 * 006, 011, 012, 013, 014, 022; FLOWS §8.2.3, §15.1, E-07, E-08.
 *
 * Driving the real store rather than a mock, for the same reason as the Phase
 * 3 draw suite: the bugs worth catching here live in the interaction between
 * handler, machine and store, and a mock would agree with whatever the handler
 * did.
 */

let seq = 0
function makeStroke(x: number, y: number, size = 20): StrokeObject {
  seq++
  const points = [x, y, 0.5, x + size, y + size, 0.5]
  const box = strokeBounds(points, 2)
  return {
    id: (`${seq}`.padStart(8, '0') + '-0000-4000-8000-000000000000') as ObjectId,
    type: 'stroke',
    ...box,
    rotation: 0,
    zIndex: `a${`${seq}`.padStart(6, '0')}`,
    opacity: 1,
    createdBy: 'test',
    createdAt: 0,
    updatedAt: 0,
    points,
    color: '#18181B',
    strokeWidth: 2,
    simplified: true,
  } as StrokeObject
}

function load(objects: BoardObject[]) {
  boardStore.getState().loadObjects(objects)
}

beforeEach(() => {
  seq = 0
  boardStore.setState({
    objects: new Map(),
    objectsVersion: 0,
    sortedIds: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    activeTool: 'select',
    interaction: { type: 'IDLE' },
    selection: [],
    eraseCandidate: null,
    draft: null,
    draftVersion: 0,
  })
  vi.stubGlobal('crypto', {
    randomUUID: () => '00000099-0000-4000-8000-000000000000',
  })
})

describe('the machine — R-CANVAS-050/051/053', () => {
  const ALL: InteractionType[] = [
    'IDLE',
    'PANNING',
    'MARQUEEING',
    'DRAGGING',
    'RESIZING',
    'ROTATING',
    'DRAWING',
    'ERASING',
    'EDITING_TEXT',
  ]

  it('allows an interaction to begin ONLY from IDLE', () => {
    const interactions = ALL.filter(t => t !== 'IDLE' && t !== 'PANNING')
    for (const from of ALL.filter(t => t !== 'IDLE')) {
      for (const to of interactions) {
        if (from === to) continue
        expect(canTransition(from, to), `${from} → ${to} must be rejected`).toBe(false)
      }
    }
  })

  it('always allows a return to IDLE, from every state', () => {
    for (const from of ALL) {
      if (from === 'IDLE') continue
      expect(canTransition(from, 'IDLE')).toBe(true)
    }
  })

  it('forbids PANNING from DRAWING, ERASING and EDITING_TEXT', () => {
    // R-CANVAS-051 for DRAWING; the same reasoning extended to the eraser,
    // where suspending a live delete gesture to pan is worse still.
    expect(canTransition('DRAWING', 'PANNING')).toBe(false)
    expect(canTransition('ERASING', 'PANNING')).toBe(false)
    expect(canTransition('EDITING_TEXT', 'PANNING')).toBe(false)
  })

  it('permits PANNING to suspend the transform states', () => {
    for (const from of [
      'IDLE',
      'MARQUEEING',
      'DRAGGING',
      'RESIZING',
      'ROTATING',
    ] as const) {
      expect(canTransition(from, 'PANNING')).toBe(true)
    }
  })

  it('marks every pointer-capturing state — R-CANVAS-053', () => {
    for (const t of CAPTURING_STATES) expect(isCapturing(t)).toBe(true)
    expect(isCapturing('IDLE')).toBe(false)
    expect(isCapturing('EDITING_TEXT')).toBe(false)
  })

  it('locks tool changes outside IDLE — R-CANVAS-055, E-08', () => {
    expect(canChangeTool('IDLE')).toBe(true)
    for (const t of ALL.filter(x => x !== 'IDLE')) expect(canChangeTool(t)).toBe(false)
  })
})

describe('single and multi select — FR-CANVAS-004', () => {
  it('selects one object on a plain click', () => {
    const a = makeStroke(0, 0)
    load([a])
    selectObject(a.id, false)
    expect(boardStore.getState().selection).toEqual([a.id])
  })

  it('Shift+click toggles membership', () => {
    const a = makeStroke(0, 0)
    const b = makeStroke(100, 100)
    load([a, b])

    selectObject(a.id, false)
    selectObject(b.id, true)
    expect(boardStore.getState().selection).toEqual([a.id, b.id])

    selectObject(a.id, true)
    expect(boardStore.getState().selection).toEqual([b.id])
  })

  it('a plain click inside a multi-selection PRESERVES it', () => {
    // Otherwise grabbing a group to drag it collapses the selection to the one
    // object under the cursor, and the drag moves the wrong thing.
    const a = makeStroke(0, 0)
    const b = makeStroke(100, 100)
    load([a, b])
    boardStore.getState().setSelection([a.id, b.id])

    selectObject(a.id, false)
    expect(boardStore.getState().selection).toEqual([a.id, b.id])
  })

  it('selectAll takes every object, not just the visible ones', () => {
    const near = makeStroke(0, 0)
    const far = makeStroke(500_000, 500_000)
    load([near, far])
    boardStore.getState().selectAll()
    expect(boardStore.getState().selection).toHaveLength(2)
  })
})

describe('probe — what a pointerdown would act on', () => {
  it('reports empty canvas, an object, then a handle in priority order', () => {
    const a = makeStroke(0, 0, 40)
    load([a])

    expect(probe(500, 500).kind).toBe('empty')
    expect(probe(20, 20)).toEqual({ kind: 'object', id: a.id })

    boardStore.getState().setSelection([a.id])
    // The 'nw' handle sits on the box corner, which is also over the object.
    // Handles must win: reaching for a corner means resize.
    const box = { x: a.x, y: a.y }
    expect(probe(box.x, box.y).kind).toBe('handle')
  })
})

describe('marquee — fully-contained selection', () => {
  it('selects what it fully encloses and ignores the rest', () => {
    const inside = makeStroke(10, 10)
    const outside = makeStroke(500, 500)
    load([inside, outside])

    beginMarquee(1, 0, 0, false)
    updateMarquee(200, 200)
    endMarquee(null)

    expect(boardStore.getState().selection).toEqual([inside.id])
    expect(boardStore.getState().interaction.type).toBe('IDLE')
  })

  it('a plain marquee replaces the selection; Shift extends it', () => {
    const a = makeStroke(10, 10)
    const b = makeStroke(300, 300)
    load([a, b])

    boardStore.getState().setSelection([b.id])
    beginMarquee(1, 0, 0, true)
    updateMarquee(200, 200)
    endMarquee(null)

    expect(boardStore.getState().selection.sort()).toEqual([a.id, b.id].sort())
  })

  it('normalises a marquee dragged up and to the left', () => {
    const a = makeStroke(10, 10)
    load([a])
    beginMarquee(1, 200, 200, false)
    updateMarquee(0, 0)
    endMarquee(null)
    expect(boardStore.getState().selection).toEqual([a.id])
  })
})

describe('drag — FR-CANVAS-011, E-07', () => {
  it('moves every selected object by the same canvas delta', () => {
    const a = makeStroke(0, 0)
    const b = makeStroke(100, 100)
    load([a, b])
    boardStore.getState().setSelection([a.id, b.id])

    beginDrag(1, 0, 0)
    updateDrag(50, 25)
    endDrag(null)

    const s = boardStore.getState()
    expect(s.objects.get(a.id)!.x).toBeCloseTo(a.x + 50, 6)
    expect(s.objects.get(b.id)!.y).toBeCloseTo(b.y + 25, 6)
    expect(s.interaction.type).toBe('IDLE')
  })

  it('commits 500 objects in ONE store write — E-07', () => {
    const many = Array.from({ length: 500 }, (_, i) => makeStroke(i * 5, 0, 4))
    load(many)
    boardStore.getState().setSelection(many.map(o => o.id))

    beginDrag(1, 0, 0)
    const before = boardStore.getState().objectsVersion
    updateDrag(10, 10)
    const after = boardStore.getState().objectsVersion

    // One version bump for the whole selection — therefore one renderer
    // repaint, not 500.
    expect(after - before).toBe(1)
    expect(boardStore.getState().objects.get(many[499]!.id)!.x).toBeCloseTo(
      many[499]!.x + 10,
      6,
    )
  })

  it('ignores sub-threshold movement, so a click is not a drag', () => {
    const a = makeStroke(0, 0)
    load([a])
    boardStore.getState().setSelection([a.id])

    beginDrag(1, 0, 0)
    updateDrag(0.5, 0.5)

    expect(boardStore.getState().objects.get(a.id)!.x).toBe(a.x)
  })

  it('recomputes from the ORIGIN, so repeated updates do not accumulate', () => {
    const a = makeStroke(0, 0)
    load([a])
    boardStore.getState().setSelection([a.id])

    beginDrag(1, 0, 0)
    updateDrag(50, 0)
    updateDrag(50, 0)
    updateDrag(50, 0)

    // Three identical moves land in the same place, not 150 units away.
    expect(boardStore.getState().objects.get(a.id)!.x).toBeCloseTo(a.x + 50, 6)
  })

  it('cancel restores every object to its pointerdown position', () => {
    const a = makeStroke(0, 0)
    load([a])
    boardStore.getState().setSelection([a.id])

    beginDrag(1, 0, 0)
    updateDrag(200, 200)
    cancelDrag(null)

    expect(boardStore.getState().objects.get(a.id)!.x).toBeCloseTo(a.x, 6)
    expect(boardStore.getState().interaction.type).toBe('IDLE')
  })

  it('releases the pointer on cancel — R-CANVAS-053', () => {
    const release = vi.fn()
    const el = { releasePointerCapture: release } as unknown as Element
    const a = makeStroke(0, 0)
    load([a])
    boardStore.getState().setSelection([a.id])

    beginDrag(7, 0, 0)
    cancelDrag(el)
    expect(release).toHaveBeenCalledWith(7)
  })

  it('refuses to start with nothing selected', () => {
    expect(beginDrag(1, 0, 0)).toBe(false)
  })
})

describe('resize through the store', () => {
  it('scales the selection and clamps at 8×8', () => {
    const a = makeStroke(0, 0, 40)
    load([a])
    boardStore.getState().setSelection([a.id])

    expect(beginResize(1, 'se')).toBe(true)
    updateResize(0, 0, { aspect: false, fromCentre: false })

    const out = boardStore.getState().objects.get(a.id)!
    expect(out.width).toBeGreaterThanOrEqual(8)
    expect(out.height).toBeGreaterThanOrEqual(8)
  })

  it('cancel restores the original geometry', () => {
    const a = makeStroke(0, 0, 40)
    load([a])
    boardStore.getState().setSelection([a.id])

    beginResize(1, 'se')
    updateResize(500, 500, { aspect: false, fromCentre: false })
    cancelResize(null)

    expect(boardStore.getState().objects.get(a.id)!.width).toBeCloseTo(a.width, 6)
  })
})

describe('rotate through the store', () => {
  it('records the start angle so the selection does not jump', () => {
    const a = makeStroke(0, 0, 40)
    load([a])
    boardStore.getState().setSelection([a.id])

    expect(beginRotate(1, 20, -100)).toBe(true)
    const s = boardStore.getState().interaction
    expect(s.type).toBe('ROTATING')
    // Object is untouched until the pointer actually moves.
    expect(boardStore.getState().objects.get(a.id)!.rotation).toBe(0)
  })
})

describe('nudge — FR-CANVAS-011', () => {
  it('moves by the given canvas delta', () => {
    const a = makeStroke(0, 0)
    load([a])
    boardStore.getState().setSelection([a.id])

    nudgeSelection(1, 0)
    expect(boardStore.getState().objects.get(a.id)!.x).toBeCloseTo(a.x + 1, 6)

    nudgeSelection(0, 10)
    expect(boardStore.getState().objects.get(a.id)!.y).toBeCloseTo(a.y + 10, 6)
  })

  it('is inert with nothing selected', () => {
    const a = makeStroke(0, 0)
    load([a])
    nudgeSelection(10, 10)
    expect(boardStore.getState().objects.get(a.id)!.x).toBe(a.x)
  })
})

describe('delete — FR-CANVAS-014', () => {
  it('removes the objects and drops them from the selection', () => {
    const a = makeStroke(0, 0)
    const b = makeStroke(100, 100)
    load([a, b])
    boardStore.getState().setSelection([a.id, b.id])

    boardStore.getState().deleteObjects([a.id])

    const s = boardStore.getState()
    expect(s.objects.has(a.id)).toBe(false)
    expect(s.sortedIds).toEqual([b.id])
    expect(s.selection).toEqual([b.id])
  })

  it('deletes many in one commit', () => {
    const many = Array.from({ length: 50 }, (_, i) => makeStroke(i * 30, 0))
    load(many)
    const before = boardStore.getState().objectsVersion

    boardStore.getState().deleteObjects(many.map(o => o.id))

    expect(boardStore.getState().objects.size).toBe(0)
    expect(boardStore.getState().objectsVersion - before).toBe(1)
  })
})

describe('eraser — FR-CANVAS-006', () => {
  it('highlights the object under the pointer without deleting it', () => {
    const a = makeStroke(0, 0, 40)
    load([a])

    updateEraseHover(20, 20)
    expect(boardStore.getState().eraseCandidate).toBe(a.id)
    expect(boardStore.getState().objects.has(a.id)).toBe(true)

    updateEraseHover(9_000, 9_000)
    expect(boardStore.getState().eraseCandidate).toBeNull()
  })

  it('deletes what the drag touches, and only once each', () => {
    const a = makeStroke(0, 0, 40)
    const b = makeStroke(200, 200, 40)
    load([a, b])

    beginErase(1, 20, 20)
    expect(boardStore.getState().objects.has(a.id)).toBe(false)

    // Lingering over the same spot must not try to delete it again.
    eraseAt(20, 20)
    eraseAt(220, 220)
    endErase(null)

    expect(boardStore.getState().objects.size).toBe(0)
    expect(boardStore.getState().interaction.type).toBe('IDLE')
    expect(boardStore.getState().eraseCandidate).toBeNull()
  })

  it('deletes nothing when the drag starts over empty canvas', () => {
    const a = makeStroke(0, 0)
    load([a])
    beginErase(1, 9_000, 9_000)
    endErase(null)
    expect(boardStore.getState().objects.size).toBe(1)
  })
})

describe('interaction exclusivity', () => {
  it('a pan in progress blocks every other gesture', () => {
    const a = makeStroke(0, 0)
    load([a])
    boardStore.getState().setSelection([a.id])

    beginPan(1, 0, 0)
    expect(beginDrag(2, 0, 0)).toBe(false)
    expect(beginResize(2, 'se')).toBe(false)
    expect(beginRotate(2, 0, 0)).toBe(false)
    expect(beginErase(2, 0, 0)).toBe(false)
    expect(beginMarquee(2, 0, 0, false)).toBe(false)
    expect(boardStore.getState().interaction.type).toBe('PANNING')
  })

  it('a stroke in progress blocks selection gestures', () => {
    boardStore.setState({ activeTool: 'pen' })
    beginDraw(1, 0, 0, 0.5)
    expect(beginMarquee(2, 0, 0, false)).toBe(false)
    expect(beginErase(2, 0, 0)).toBe(false)
    expect(boardStore.getState().interaction.type).toBe('DRAWING')
  })
})
