import { CULL_PADDING_PX, type BoardObject, type Viewport } from '@coboard/shared'

/**
 * Viewport culling — TRD §7.4, R-CANVAS-026.
 *
 * Client-only: it needs the DOM-sized viewport rectangle, which the server has
 * no concept of. The pure geometry it builds on lives in @coboard/shared.
 *
 * R-CANVAS-029: do NOT build a spatial index preemptively. A linear filter is
 * fine to ~10,000 objects. Measure first — the Playwright perf test in
 * tests/e2e/canvas-performance.spec.ts is that measurement.
 */

export interface ViewRect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** The visible rectangle in CANVAS coordinates, with a pad so objects don't pop in. */
export function getViewRect(v: Viewport, width: number, height: number): ViewRect {
  const pad = CULL_PADDING_PX / v.zoom
  return {
    minX: -v.x / v.zoom - pad,
    minY: -v.y / v.zoom - pad,
    maxX: (width - v.x) / v.zoom + pad,
    maxY: (height - v.y) / v.zoom + pad,
  }
}

export const isVisible = (o: BoardObject, view: ViewRect): boolean =>
  o.x + o.width >= view.minX && o.x <= view.maxX && o.y + o.height >= view.minY && o.y <= view.maxY

/**
 * Filter to visible objects.
 *
 * Takes a pre-allocated output array so the render loop does not allocate
 * (R-CANVAS-024) — GC pauses show up as dropped frames.
 */
export function collectVisible(
  objects: Iterable<BoardObject>,
  view: ViewRect,
  out: BoardObject[],
): BoardObject[] {
  out.length = 0
  for (const o of objects) {
    if (isVisible(o, view)) out.push(o)
  }
  return out
}

/** Convenience form for tests and non-hot paths. */
export function getVisibleObjects(
  objects: readonly BoardObject[],
  v: Viewport,
  width: number,
  height: number,
): BoardObject[] {
  return collectVisible(objects, getViewRect(v, width, height), [])
}
