import { beforeEach, describe, expect, it } from 'vitest'
import { COORD_MAX, ZOOM_MAX, ZOOM_MIN, type BoardObject } from '@coboard/shared'
import { useBoardStore } from '../../../stores/boardStore.js'
import { getViewRect, getVisibleObjects, isVisible } from '../geometry/culling.js'
import { backingStoreSize } from '../renderer/resizeCanvas.js'
import {
  canChangeTool,
  canEnterPanning,
  canTransition,
  isCapturing,
  type InteractionType,
} from '../interaction/machine.js'

const obj = (over: Partial<BoardObject> = {}): BoardObject =>
  ({
    id: '11111111-1111-4111-8111-111111111111',
    type: 'rect',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    zIndex: 'a0',
    opacity: 1,
    createdBy: 't',
    createdAt: 0,
    updatedAt: 0,
    stroke: '#000000',
    strokeWidth: 1,
    fill: '#ffffff',
    ...over,
  }) as BoardObject

const reset = () =>
  useBoardStore.setState({
    viewport: { x: 0, y: 0, zoom: 1 },
    objects: new Map(),
    sortedIds: [],
    objectsVersion: 0,
    activeTool: 'select',
    interaction: { type: 'IDLE' },
  })

beforeEach(reset)

describe('DPR handling — R-CANVAS-020', () => {
  it('caps at 2 however high the device ratio goes', () => {
    expect(backingStoreSize(800, 600, 3).dpr).toBe(2)
    expect(backingStoreSize(800, 600, 4).dpr).toBe(2)
    expect(backingStoreSize(800, 600, 3).width).toBe(1600)
  })

  it('honours ratios below the cap', () => {
    expect(backingStoreSize(800, 600, 1).dpr).toBe(1)
    expect(backingStoreSize(800, 600, 1.5)).toMatchObject({
      width: 1200,
      height: 900,
      dpr: 1.5,
    })
  })

  it('treats a zero or missing ratio as 1', () => {
    expect(backingStoreSize(800, 600, 0).dpr).toBe(1)
  })
})

describe('culling — TRD §7.4', () => {
  const view = () => getViewRect({ x: 0, y: 0, zoom: 1 }, 800, 600)

  it('includes an object fully inside', () => {
    expect(isVisible(obj({ x: 100, y: 100 }), view())).toBe(true)
  })

  it('includes an object straddling the edge', () => {
    expect(isVisible(obj({ x: 760, y: 100 }), view())).toBe(true)
  })

  it('includes an object just inside the 100px pad, so it does not pop in', () => {
    expect(isVisible(obj({ x: 850, y: 100, width: 10, height: 10 }), view())).toBe(true)
  })

  it('excludes an object beyond the pad', () => {
    expect(isVisible(obj({ x: 5000, y: 5000 }), view())).toBe(false)
  })

  it('scales the pad by zoom, so zooming out widens the visible band', () => {
    const zoomedOut = getViewRect({ x: 0, y: 0, zoom: 0.1 }, 800, 600)
    expect(zoomedOut.maxX).toBeGreaterThan(7000)
  })

  it('filters a mixed set correctly', () => {
    const all = [obj({ x: 0 }), obj({ x: 400 }), obj({ x: 99_999 })]
    expect(getVisibleObjects(all, { x: 0, y: 0, zoom: 1 }, 800, 600)).toHaveLength(2)
  })
})

describe('pan — FR-CANVAS-002, R-COORD-007', () => {
  it('applies a screen delta to the viewport', () => {
    useBoardStore.getState().panBy(50, -25)
    expect(useBoardStore.getState().viewport).toMatchObject({ x: 50, y: -25, zoom: 1 })
  })

  it('does not touch object data', () => {
    useBoardStore.getState().loadObjects([obj({ x: 10, y: 20 })])
    const before = { ...[...useBoardStore.getState().objects.values()][0]! }
    useBoardStore.getState().panBy(300, 300)
    const after = [...useBoardStore.getState().objects.values()][0]!
    expect(after.x).toBe(before.x)
    expect(after.y).toBe(before.y)
  })
})

describe('zoom — FR-CANVAS-003, R-COORD-005', () => {
  it('clamps hard at 10% and 500%', () => {
    const s = useBoardStore.getState()
    for (let i = 0; i < 60; i++) s.zoomAt(400, 300, 0.5)
    expect(useBoardStore.getState().viewport.zoom).toBe(ZOOM_MIN)

    reset()
    for (let i = 0; i < 60; i++) useBoardStore.getState().zoomAt(400, 300, 2)
    expect(useBoardStore.getState().viewport.zoom).toBe(ZOOM_MAX)
  })

  it('keeps the point under the pointer fixed', () => {
    const px = 250
    const py = 175
    const worldBefore = {
      x:
        (px - useBoardStore.getState().viewport.x) /
        useBoardStore.getState().viewport.zoom,
      y:
        (py - useBoardStore.getState().viewport.y) /
        useBoardStore.getState().viewport.zoom,
    }
    useBoardStore.getState().zoomAt(px, py, 1.75)
    const v = useBoardStore.getState().viewport
    expect((px - v.x) / v.zoom).toBeCloseTo(worldBefore.x, 6)
    expect((py - v.y) / v.zoom).toBeCloseTo(worldBefore.y, 6)
  })

  it('setZoom reaches the requested level exactly', () => {
    useBoardStore.getState().setZoom(2.5, 400, 300)
    expect(useBoardStore.getState().viewport.zoom).toBeCloseTo(2.5, 9)
  })

  it('resetZoom returns to 100%', () => {
    useBoardStore.getState().setZoom(3, 400, 300)
    useBoardStore.getState().resetZoom(400, 300)
    expect(useBoardStore.getState().viewport.zoom).toBe(1)
  })
})

describe('zoom to fit — FLOWS §8.2.4', () => {
  it('resets to origin at 100% on an empty board', () => {
    useBoardStore.getState().setZoom(3, 100, 100)
    useBoardStore.getState().zoomToFit(800, 600)
    expect(useBoardStore.getState().viewport).toEqual({ x: 0, y: 0, zoom: 1 })
  })

  it('fits the bounding box with padding and centres it', () => {
    useBoardStore
      .getState()
      .loadObjects([
        obj({ id: '1'.repeat(8) + '-1111-4111-8111-111111111111', x: 0, y: 0 }),
        obj({ id: '2'.repeat(8) + '-2222-4222-8222-222222222222', x: 900, y: 400 }),
      ])
    useBoardStore.getState().zoomToFit(800, 600)
    const v = useBoardStore.getState().viewport

    // Box is 1000x500 with 10% padding; width is the binding constraint.
    expect(v.zoom).toBeLessThan(1)
    expect(v.zoom).toBeGreaterThan(ZOOM_MIN)

    // The box centre (500, 250) should land at the viewport centre.
    expect(500 * v.zoom + v.x).toBeCloseTo(400, 6)
    expect(250 * v.zoom + v.y).toBeCloseTo(300, 6)
  })

  it('clamps when the content is tiny rather than zooming past 500%', () => {
    useBoardStore.getState().loadObjects([obj({ x: 0, y: 0, width: 1, height: 1 })])
    useBoardStore.getState().zoomToFit(800, 600)
    expect(useBoardStore.getState().viewport.zoom).toBe(ZOOM_MAX)
  })
})

describe('coordinate clamping — R-COORD-003, FLOWS E-04', () => {
  it('clamps loaded coordinates to ±1,000,000', () => {
    useBoardStore.getState().loadObjects([obj({ x: 9_000_000, y: -9_000_000 })])
    const o = [...useBoardStore.getState().objects.values()][0]!
    expect(o.x).toBe(COORD_MAX)
    expect(o.y).toBe(-COORD_MAX)
  })
})

describe('interaction machine — FLOWS §15.1', () => {
  it('forbids PANNING from DRAWING — R-CANVAS-051', () => {
    // Holding Space during a stroke must do nothing. Allowing it corrupts the
    // stroke (anti-pattern A-22).
    expect(canEnterPanning('DRAWING')).toBe(false)
    expect(canTransition('DRAWING', 'PANNING')).toBe(false)
  })

  it('forbids PANNING from EDITING_TEXT, where Space is a real character', () => {
    expect(canEnterPanning('EDITING_TEXT')).toBe(false)
  })

  it('allows PANNING from IDLE and from transform states', () => {
    for (const from of [
      'IDLE',
      'DRAGGING',
      'RESIZING',
      'ROTATING',
      'MARQUEEING',
    ] as const) {
      expect(canEnterPanning(from)).toBe(true)
    }
  })

  it('always allows a return to IDLE, from every state', () => {
    const all: InteractionType[] = [
      'PANNING',
      'MARQUEEING',
      'DRAGGING',
      'RESIZING',
      'ROTATING',
      'DRAWING',
      'EDITING_TEXT',
    ]
    for (const from of all) expect(canTransition(from, 'IDLE')).toBe(true)
  })

  it('only starts a new interaction from rest', () => {
    expect(canTransition('IDLE', 'DRAWING')).toBe(true)
    expect(canTransition('DRAGGING', 'DRAWING')).toBe(false)
    expect(canTransition('DRAWING', 'DRAGGING')).toBe(false)
  })

  it('rejects a self-transition', () => {
    expect(canTransition('DRAGGING', 'DRAGGING')).toBe(false)
  })

  it('knows which states hold a captured pointer — R-CANVAS-053', () => {
    expect(isCapturing('PANNING')).toBe(true)
    expect(isCapturing('DRAWING')).toBe(true)
    expect(isCapturing('IDLE')).toBe(false)
    expect(isCapturing('EDITING_TEXT')).toBe(false)
  })

  it('queues tool changes during an interaction — R-CANVAS-055, FLOWS E-08', () => {
    expect(canChangeTool('IDLE')).toBe(true)
    expect(canChangeTool('DRAGGING')).toBe(false)
    expect(canChangeTool('PANNING')).toBe(false)
  })
})

describe('tool state', () => {
  it('defaults to select and switches to hand', () => {
    expect(useBoardStore.getState().activeTool).toBe('select')
    useBoardStore.getState().setActiveTool('hand')
    expect(useBoardStore.getState().activeTool).toBe('hand')
  })
})

describe('object loading', () => {
  it('sorts ids by the fractional z-index string — TRD §6.4', () => {
    useBoardStore
      .getState()
      .loadObjects([
        obj({ id: 'aaaaaaaa-1111-4111-8111-111111111111', zIndex: 'a2' }),
        obj({ id: 'bbbbbbbb-2222-4222-8222-222222222222', zIndex: 'a0' }),
        obj({ id: 'cccccccc-3333-4333-8333-333333333333', zIndex: 'a1' }),
      ])
    const { sortedIds, objects } = useBoardStore.getState()
    expect(sortedIds.map(id => objects.get(id)!.zIndex)).toEqual(['a0', 'a1', 'a2'])
  })

  it('bumps objectsVersion so the renderer notices — R-STATE-002', () => {
    const before = useBoardStore.getState().objectsVersion
    useBoardStore.getState().loadObjects([obj()])
    expect(useBoardStore.getState().objectsVersion).toBe(before + 1)
  })
})
