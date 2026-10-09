import { describe, expect, it, vi } from 'vitest'
import { drawPresence, type PresenceView } from '../drawPresence.js'

/**
 * FR-RT-005 — "a thin outline in that user's colour WITH THEIR NAME LABEL".
 *
 * drawPresence is handed the layer-3 context and nothing else, so everything
 * it draws lands on the overlay (R-CANVAS-002). These pin what it draws for a
 * remote selection: the dashed outline and, above it, the name.
 */

function recorder() {
  const texts: string[] = []
  const pills: Array<{ x: number; y: number; w: number; h: number }> = []
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    setLineDash: vi.fn(),
    roundRect: vi.fn((x: number, y: number, w: number, h: number) => {
      pills.push({ x, y, w, h })
    }),
    strokeRect: vi.fn(),
    measureText: (s: string) => ({ width: s.length * 6 }),
    fillText: vi.fn((text: string) => {
      texts.push(text)
    }),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textBaseline: 'alphabetic',
  }
  return { ctx, texts, pills }
}

const view = (selections: PresenceView['selections']): PresenceView => ({
  cursors: [],
  strokes: [],
  selections,
})

describe('remote selection labels — FR-RT-005', () => {
  it("draws the selecting user's name in a pill above the outline", () => {
    const { ctx, texts, pills } = recorder()
    drawPresence(ctx as unknown as CanvasRenderingContext2D, {
      viewport: { x: 0, y: 0, zoom: 1 },
      now: 0,
      view: view([
        { box: { x: 100, y: 200, width: 50, height: 40 }, colour: '#3B82F6', name: 'Marcus' },
      ]),
    })

    expect(ctx.strokeRect).toHaveBeenCalledTimes(1)
    expect(texts).toEqual(['Marcus'])
    // On the box's left edge and entirely ABOVE its top, so it never covers
    // the object being worked on.
    const pill = pills[0]!
    expect(pill.x).toBe(100)
    expect(pill.y + pill.h).toBeLessThanOrEqual(200)
  })

  it('is placed in screen space, so it follows pan and zoom', () => {
    const { ctx, pills } = recorder()
    drawPresence(ctx as unknown as CanvasRenderingContext2D, {
      viewport: { x: 30, y: -10, zoom: 2 },
      now: 0,
      view: view([
        { box: { x: 100, y: 200, width: 50, height: 40 }, colour: '#3B82F6', name: 'Ana' },
      ]),
    })
    // 100 * 2 + 30, and the box top at 200 * 2 - 10.
    expect(pills[0]!.x).toBe(230)
    expect(pills[0]!.y + pills[0]!.h).toBeLessThanOrEqual(390)
    // A pill is a constant size on screen, whatever the zoom.
    expect(pills[0]!.h).toBe(18)
  })

  it('labels each remote selection with its own name', () => {
    const { ctx, texts } = recorder()
    drawPresence(ctx as unknown as CanvasRenderingContext2D, {
      viewport: { x: 0, y: 0, zoom: 1 },
      now: 0,
      view: view([
        { box: { x: 0, y: 0, width: 10, height: 10 }, colour: '#EF4444', name: 'Ana' },
        { box: { x: 50, y: 50, width: 10, height: 10 }, colour: '#22C55E', name: 'Ben' },
      ]),
    })
    expect(texts).toEqual(['Ana', 'Ben'])
  })
})
