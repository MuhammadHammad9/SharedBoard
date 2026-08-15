import { describe, expect, it } from 'vitest'
import {
  ZOOM_MAX,
  ZOOM_MIN,
  canvasToScreen,
  clampCoord,
  clampZoom,
  normalizeRotation,
  rectContains,
  rectsIntersect,
  screenToCanvas,
  unionRects,
  zoomAtPoint,
  type CanvasPoint,
  type ScreenPoint,
  type Viewport,
} from '../index.js'

const cp = (x: number, y: number) => ({ x, y }) as unknown as CanvasPoint
const sp = (x: number, y: number) => ({ x, y }) as unknown as ScreenPoint

describe('coordinate conversion — TRD §7.3', () => {
  const viewports: Viewport[] = [
    { x: 0, y: 0, zoom: 1 },
    { x: 120, y: -80, zoom: 0.5 },
    { x: -1000, y: 2000, zoom: 3.25 },
    { x: 17.5, y: -3.25, zoom: ZOOM_MIN },
    { x: -42, y: 42, zoom: ZOOM_MAX },
  ]

  it('round-trips screen → canvas → screen across many viewports', () => {
    for (const v of viewports) {
      for (const [x, y] of [
        [0, 0],
        [640, 480],
        [-250, 900],
        [1.5, -7.25],
      ]) {
        const original = sp(x!, y!)
        const back = canvasToScreen(screenToCanvas(original, v), v)
        expect(back.x).toBeCloseTo(original.x, 9)
        expect(back.y).toBeCloseTo(original.y, 9)
      }
    }
  })

  it('round-trips canvas → screen → canvas', () => {
    for (const v of viewports) {
      const original = cp(123.456, -789.012)
      const back = screenToCanvas(canvasToScreen(original, v), v)
      expect(back.x).toBeCloseTo(original.x, 9)
      expect(back.y).toBeCloseTo(original.y, 9)
    }
  })
})

describe('pointer-anchored zoom — R-COORD-005, non-negotiable', () => {
  it('keeps the world point under the pointer FIXED', () => {
    const v: Viewport = { x: 40, y: -25, zoom: 1 }
    const pointer = sp(500, 300)
    const before = screenToCanvas(pointer, v)

    for (const factor of [1.1, 0.9, 2, 0.5, 1.25]) {
      const next = zoomAtPoint(v, pointer, factor)
      const after = screenToCanvas(pointer, next)
      expect(after.x).toBeCloseTo(before.x, 6)
      expect(after.y).toBeCloseTo(before.y, 6)
    }
  })

  it('is stable across a long chain of zoom steps', () => {
    let v: Viewport = { x: 0, y: 0, zoom: 1 }
    const pointer = sp(321, 654)
    const before = screenToCanvas(pointer, v)
    for (let i = 0; i < 40; i++) v = zoomAtPoint(v, pointer, i % 2 === 0 ? 1.15 : 0.95)
    const after = screenToCanvas(pointer, v)
    expect(after.x).toBeCloseTo(before.x, 4)
    expect(after.y).toBeCloseTo(before.y, 4)
  })

  it('clamps hard at both ends — FR-CANVAS-003, 10% to 500%', () => {
    let v: Viewport = { x: 0, y: 0, zoom: 1 }
    for (let i = 0; i < 60; i++) v = zoomAtPoint(v, sp(100, 100), 0.5)
    expect(v.zoom).toBe(ZOOM_MIN)

    v = { x: 0, y: 0, zoom: 1 }
    for (let i = 0; i < 60; i++) v = zoomAtPoint(v, sp(100, 100), 2)
    expect(v.zoom).toBe(ZOOM_MAX)
  })
})

describe('clamping — R-COORD-003, FLOWS E-04', () => {
  it('clamps coordinates to ±1,000,000', () => {
    expect(clampCoord(5_000_000)).toBe(1_000_000)
    expect(clampCoord(-5_000_000)).toBe(-1_000_000)
    expect(clampCoord(1234.5)).toBe(1234.5)
  })

  it('clamps zoom to the documented range', () => {
    expect(clampZoom(99)).toBe(ZOOM_MAX)
    expect(clampZoom(0.0001)).toBe(ZOOM_MIN)
  })
})

describe('rect helpers', () => {
  const a = { x: 0, y: 0, width: 100, height: 100 }

  it('detects intersection including edge contact', () => {
    expect(rectsIntersect(a, { x: 50, y: 50, width: 100, height: 100 })).toBe(true)
    expect(rectsIntersect(a, { x: 100, y: 0, width: 10, height: 10 })).toBe(true)
    expect(rectsIntersect(a, { x: 200, y: 200, width: 10, height: 10 })).toBe(false)
  })

  it('requires FULL containment for marquee selection — FLOWS §8.2.3', () => {
    expect(rectContains(a, { x: 10, y: 10, width: 50, height: 50 })).toBe(true)
    // Partially overlapping must NOT be selected by a marquee.
    expect(rectContains(a, { x: 90, y: 90, width: 50, height: 50 })).toBe(false)
  })

  it('unions rects and returns null for an empty set', () => {
    expect(unionRects([])).toBeNull()
    expect(unionRects([a, { x: -50, y: 20, width: 20, height: 200 }])).toEqual({
      x: -50,
      y: 0,
      width: 150,
      height: 220,
    })
  })
})

describe('normalizeRotation — FR-CANVAS-013, 0–359.99', () => {
  it('wraps negatives and multiples of 360', () => {
    expect(normalizeRotation(0)).toBe(0)
    expect(normalizeRotation(360)).toBe(0)
    expect(normalizeRotation(-90)).toBe(270)
    expect(normalizeRotation(725)).toBe(5)
  })
})
