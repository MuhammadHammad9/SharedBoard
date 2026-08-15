/**
 * Pure geometry helpers, imported by both client and server.
 *
 * R-COORD-004 (Required): coordinate conversion happens ONLY through these
 * helpers. Do not inline the arithmetic at call sites.
 */

import { COORD_MAX, COORD_MIN, ZOOM_MAX, ZOOM_MIN } from './constants.js'
import type { CanvasPoint, ScreenPoint, Viewport } from './types/branded.js'

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value

/** R-COORD-003 — clamp coordinates on creation, client and server. */
export const clampCoord = (value: number): number => clamp(value, COORD_MIN, COORD_MAX)

/** R-COORD-006 — zoom clamps hard at 10% and 500%. */
export const clampZoom = (zoom: number): number => clamp(zoom, ZOOM_MIN, ZOOM_MAX)

/** canvas → screen. TRD §7.3. */
export const canvasToScreen = (p: CanvasPoint, v: Viewport): ScreenPoint =>
  ({ x: p.x * v.zoom + v.x, y: p.y * v.zoom + v.y }) as unknown as ScreenPoint

/** screen → canvas. TRD §7.3. */
export const screenToCanvas = (p: ScreenPoint, v: Viewport): CanvasPoint =>
  ({ x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom }) as unknown as CanvasPoint

/**
 * Pointer-anchored zoom. FLOWS §8.2.4, R-COORD-005 (Blocking).
 *
 * The point under the cursor must not move. Centre-anchored zoom feels broken
 * and is explicitly non-negotiable in the PRD.
 */
export function zoomAtPoint(v: Viewport, pointer: ScreenPoint, factor: number): Viewport {
  const worldPos = screenToCanvas(pointer, v)
  const newZoom = clampZoom(v.zoom * factor)
  return {
    x: pointer.x - worldPos.x * newZoom,
    y: pointer.y - worldPos.y * newZoom,
    zoom: newZoom,
  }
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export const rectsIntersect = (a: Rect, b: Rect): boolean =>
  a.x + a.width >= b.x && a.x <= b.x + b.width && a.y + a.height >= b.y && a.y <= b.y + b.height

/** True when `inner` is FULLY contained by `outer` — marquee selection rule. */
export const rectContains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height

/** Union of a set of rects. Returns null for an empty input. */
export function unionRects(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rects) {
    if (r.x < minX) minX = r.x
    if (r.y < minY) minY = r.y
    if (r.x + r.width > maxX) maxX = r.x + r.width
    if (r.y + r.height > maxY) maxY = r.y + r.height
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** Squared distance from a point to a line segment. Squared to avoid a sqrt. */
export function distanceToSegmentSq(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) {
    const ax = px - x1
    const ay = py - y1
    return ax * ax + ay * ay
  }
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const cx = x1 + t * dx
  const cy = y1 + t * dy
  const ex = px - cx
  const ey = py - cy
  return ex * ex + ey * ey
}

/** Rotation normalized to [0, 360). */
export const normalizeRotation = (deg: number): number => ((deg % 360) + 360) % 360
