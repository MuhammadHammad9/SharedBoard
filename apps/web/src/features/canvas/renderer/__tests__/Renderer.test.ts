import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardObject, Viewport } from '@coboard/shared'
import { Renderer } from '../Renderer.js'

/**
 * Renderer tests.
 *
 * The layer-isolation suite below is the important one. R-CANVAS-002 is
 * described in the specs as "the single most important performance rule in
 * this project", and it is a LAYERING property — decided here in Phase 2, but
 * only violated visibly in Phase 10 when remote cursors start redrawing the
 * overlay at 20 Hz. Testing it now means the regression is caught eight phases
 * before it would otherwise surface.
 */

/** Minimal 2D context stub that counts the calls we care about. */
function stubContext() {
  const calls = { clearRect: 0, fillRect: 0, setTransform: 0 }
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    setTransform: vi.fn(() => void calls.setTransform++),
    clearRect: vi.fn(() => void calls.clearRect++),
    fillRect: vi.fn(() => void calls.fillRect++),
    fillStyle: '',
    globalAlpha: 1,
    lineWidth: 1,
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

function makeObject(i: number, overrides: Partial<BoardObject> = {}): BoardObject {
  return {
    id: `${i}`.padStart(8, '0') + '-0000-4000-8000-000000000000',
    type: 'rect',
    x: i * 10,
    y: 0,
    width: 8,
    height: 8,
    rotation: 0,
    zIndex: `a${i}`,
    opacity: 1,
    createdBy: 'test',
    createdAt: 0,
    updatedAt: 0,
    stroke: '#000000',
    strokeWidth: 1,
    fill: '#ffffff',
    ...overrides,
  } as BoardObject
}

function build(objects: BoardObject[] = [], viewport: Viewport = { x: 0, y: 0, zoom: 1 }) {
  const objectsTarget = stubContext()
  const interactionTarget = stubContext()
  const overlayTarget = stubContext()

  const renderer = new Renderer(
    {
      objects: objectsTarget.ctx,
      interaction: interactionTarget.ctx,
      overlay: overlayTarget.ctx,
    },
    {
      getViewport: () => viewport,
      getObjects: () => objects,
      getSize: () => ({ width: 800, height: 600 }),
    },
    () => 1,
  )

  return { renderer, objectsTarget, interactionTarget, overlayTarget }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('R-CANVAS-002 — layer isolation', () => {
  it('marking the OVERLAY dirty never redraws the object layer', () => {
    const { renderer, objectsTarget, overlayTarget } = build([makeObject(1)])

    // One initial paint: every layer starts dirty.
    renderer.renderOnce()
    const objectClearsAfterFirst = objectsTarget.calls.clearRect
    expect(objectClearsAfterFirst).toBe(1)

    // Simulate Phase 10: a remote cursor moving at 20 Hz for five seconds.
    for (let i = 0; i < 100; i++) {
      renderer.markDirty('overlay')
      renderer.renderOnce()
    }

    // The overlay repainted every time...
    expect(overlayTarget.calls.clearRect).toBe(101)
    // ...and the object layer did not repaint once.
    expect(objectsTarget.calls.clearRect).toBe(objectClearsAfterFirst)
  })

  it('marking the INTERACTION layer dirty never redraws the object layer', () => {
    const { renderer, objectsTarget, interactionTarget } = build([makeObject(1)])
    renderer.renderOnce()
    const baseline = objectsTarget.calls.clearRect

    for (let i = 0; i < 50; i++) {
      renderer.markDirty('interaction')
      renderer.renderOnce()
    }

    expect(interactionTarget.calls.clearRect).toBe(51)
    expect(objectsTarget.calls.clearRect).toBe(baseline)
  })

  it('marking the object layer dirty does redraw it', () => {
    const { renderer, objectsTarget } = build([makeObject(1)])
    renderer.renderOnce()
    renderer.markDirty('objects')
    renderer.renderOnce()
    expect(objectsTarget.calls.clearRect).toBe(2)
  })
})

describe('dirty flags', () => {
  it('a clean renderer paints nothing on a second pass', () => {
    const { renderer, objectsTarget, interactionTarget, overlayTarget } = build([makeObject(1)])
    renderer.renderOnce()
    renderer.renderOnce()
    expect(objectsTarget.calls.clearRect).toBe(1)
    expect(interactionTarget.calls.clearRect).toBe(1)
    expect(overlayTarget.calls.clearRect).toBe(1)
  })

  it('markAllDirty repaints every layer', () => {
    const { renderer, objectsTarget, interactionTarget, overlayTarget } = build()
    renderer.renderOnce()
    renderer.markAllDirty()
    renderer.renderOnce()
    expect(objectsTarget.calls.clearRect).toBe(2)
    expect(interactionTarget.calls.clearRect).toBe(2)
    expect(overlayTarget.calls.clearRect).toBe(2)
  })
})

describe('culling in the draw path', () => {
  it('draws only objects inside the padded view rectangle', () => {
    const objects = [
      makeObject(1, { x: 100, y: 100 }), // visible
      makeObject(2, { x: 400, y: 300 }), // visible
      makeObject(3, { x: 90_000, y: 90_000 }), // far off-screen
    ]
    const { renderer, objectsTarget } = build(objects)
    renderer.renderOnce()
    expect(objectsTarget.calls.fillRect).toBe(2)
  })

  it('draws nothing when every object is off-screen', () => {
    const { renderer, objectsTarget } = build([makeObject(1, { x: 50_000, y: 50_000 })])
    renderer.renderOnce()
    expect(objectsTarget.calls.fillRect).toBe(0)
  })
})

describe('lifecycle — R-CANVAS-010, R-CANVAS-014', () => {
  // The suite runs in the `node` environment, which has no rAF. Stub it rather
  // than spy on a global that does not exist.
  const withRafStub = (handle: number) => {
    const raf = vi.fn(() => handle)
    const caf = vi.fn()
    vi.stubGlobal('requestAnimationFrame', raf)
    vi.stubGlobal('cancelAnimationFrame', caf)
    return { raf, caf }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('start is idempotent, so a second call cannot create a second loop', () => {
    const { raf } = withRafStub(1)
    const { renderer } = build()

    renderer.start()
    renderer.start()
    renderer.start()

    // R-CANVAS-010: exactly one loop, however many times start is called.
    expect(raf).toHaveBeenCalledTimes(1)
    renderer.stop()
  })

  it('stop cancels the frame and clears the running flag', () => {
    const { caf } = withRafStub(42)
    const { renderer } = build()

    renderer.start()
    expect(renderer.isRunning).toBe(true)
    renderer.stop()

    expect(caf).toHaveBeenCalledWith(42)
    expect(renderer.isRunning).toBe(false)
  })

  it('can be restarted after stopping, as visibilitychange requires', () => {
    const { raf } = withRafStub(7)
    const { renderer } = build()

    renderer.start()
    renderer.stop()
    renderer.start()

    expect(raf).toHaveBeenCalledTimes(2)
    expect(renderer.isRunning).toBe(true)
    renderer.stop()
  })
})

describe('frame metrics', () => {
  it('reports zeros before any frame has been painted', () => {
    const { renderer } = build()
    expect(renderer.getMetrics()).toMatchObject({ p50: 0, p95: 0, count: 0 })
  })

  it('resetMetrics clears the window', () => {
    const { renderer } = build()
    renderer.resetMetrics()
    expect(renderer.getMetrics().count).toBe(0)
  })
})
