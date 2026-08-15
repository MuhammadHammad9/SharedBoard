/**
 * Pure geometry helpers, imported by both client and server.
 *
 * R-COORD-004 (Required): coordinate conversion happens ONLY through these
 * helpers. Do not inline the arithmetic at call sites.
 */

import {
  COORD_MAX,
  COORD_MIN,
  SIMPLIFY_EPSILON,
  STROKE_POINT_STRIDE,
  ZOOM_MAX,
  ZOOM_MIN,
} from './constants.js'
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
  a.x + a.width >= b.x &&
  a.x <= b.x + b.width &&
  a.y + a.height >= b.y &&
  a.y <= b.y + b.height

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

/* ────────────────────────────────────────────────────────────────────────────
 * Hit-test primitives — TRD §7.7
 *
 * Pure predicates over a point and a shape. They live here rather than in the
 * client because the geometry is not DOM-dependent, and because Phase 9's
 * server-side op validation needs the same notion of "inside" that the client
 * used when it decided what the user clicked.
 * ──────────────────────────────────────────────────────────────────────────── */

export const pointInRect = (px: number, py: number, r: Rect): boolean =>
  px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height

/** Standard ellipse test: (dx/rx)² + (dy/ry)² ≤ 1. TRD §7.7. */
export function pointInEllipse(px: number, py: number, r: Rect): boolean {
  const rx = r.width / 2
  const ry = r.height / 2
  // A degenerate axis has no interior; fall back to the box so a zero-height
  // ellipse is still clickable rather than silently unselectable.
  if (rx <= 0 || ry <= 0) return pointInRect(px, py, r)
  const dx = (px - (r.x + rx)) / rx
  const dy = (py - (r.y + ry)) / ry
  return dx * dx + dy * dy <= 1
}

/**
 * Transform a point into an object's local (unrotated) space —
 * R-CANVAS-042, TRD §7.7.
 *
 * Translate to the centre, rotate by −rotation, translate back. Every precise
 * test can then be axis-aligned, which is the whole reason this exists: a
 * rotated-rectangle containment test is fiddly and easy to get subtly wrong,
 * whereas rotating the *point* is four lines and obviously correct.
 */
export function toLocalSpace(
  px: number,
  py: number,
  centreX: number,
  centreY: number,
  rotationDeg: number,
): { x: number; y: number } {
  if (rotationDeg === 0) return { x: px, y: py }
  const rad = (-rotationDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = px - centreX
  const dy = py - centreY
  return {
    x: centreX + dx * cos - dy * sin,
    y: centreY + dx * sin + dy * cos,
  }
}

/**
 * The axis-aligned box that encloses a rotated rect.
 *
 * Used for the cheap AABB rejection phase: a rotated object's true extent is
 * larger than its own width and height, and rejecting against the unrotated
 * box would make the corners of a rotated object unclickable.
 */
export function rotatedBounds(r: Rect, rotationDeg: number): Rect {
  if (rotationDeg === 0) return r
  const rad = (rotationDeg * Math.PI) / 180
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))
  const w = r.width * cos + r.height * sin
  const h = r.width * sin + r.height * cos
  return {
    x: r.x + r.width / 2 - w / 2,
    y: r.y + r.height / 2 - h / 2,
    width: w,
    height: h,
  }
}

/**
 * Smallest squared distance from a point to a stride-3 polyline.
 *
 * Early-exits as soon as it is within `withinSq`, because the caller only ever
 * asks "is this close enough?" — computing the true minimum across a
 * 60-segment stroke when segment 2 already answers the question is wasted work
 * on a path that runs per object per click (TRD §7.7).
 */
export function distanceToPolylineSq(
  px: number,
  py: number,
  points: readonly number[],
  withinSq = Infinity,
): number {
  const s = STROKE_POINT_STRIDE
  if (points.length < s * 2) {
    if (points.length < 2) return Infinity
    const dx = px - points[0]!
    const dy = py - points[1]!
    return dx * dx + dy * dy
  }

  let best = Infinity
  for (let i = 0; i + s * 2 - 1 < points.length; i += s) {
    const d = distanceToSegmentSq(
      px,
      py,
      points[i]!,
      points[i + 1]!,
      points[i + s]!,
      points[i + s + 1]!,
    )
    if (d < best) best = d
    if (best <= withinSq) return best
  }
  return best
}

/* ────────────────────────────────────────────────────────────────────────────
 * Stroke geometry — TRD §7.5, D-9
 *
 * Strokes are a FLAT number[] with stride 3: [x0,y0,p0, x1,y1,p1, …]
 * (R-CANVAS-030). `{x,y,p}[]` for a 200-point stroke allocates 200 objects and
 * serializes to roughly 3× the bytes.
 *
 * These live in the shared package rather than the client because they are
 * pure geometry with no DOM dependency, and the server needs the same
 * simplification to bound op payloads in Phase 9 (R-ARCH-007 — no duplicate
 * across the boundary).
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Ramer–Douglas–Peucker simplification over a stride-3 point array.
 *
 * R-CANVAS-032 (Blocking): run this ONCE, on `pointerup`. Never during the
 * stroke — simplifying a growing array every pointermove is O(n²) work for a
 * result that is thrown away on the next move.
 *
 * A 3-second scribble produces roughly 400 raw points and simplifies to around
 * 60 at ε = 0.5 with no visible difference: a 6× reduction in payload,
 * database storage and per-frame draw cost.
 *
 * ITERATIVE, not recursive. A 10,000-point stroke (the STROKE_POINTS_MAX
 * ceiling) recursed naively is a stack overflow on a pathological input, which
 * a hostile client can produce deliberately.
 *
 * The first and last points survive exactly — RDP is anchored on them by
 * construction, and a stroke whose endpoints drifted would visibly detach from
 * where the user started and stopped. Each kept point carries its own pressure
 * through unchanged.
 */
export function simplifyStroke(
  points: readonly number[],
  epsilon = SIMPLIFY_EPSILON,
): number[] {
  const stride = STROKE_POINT_STRIDE
  const count = Math.floor(points.length / stride)
  // Two points are already minimal: no interior point exists to discard.
  if (count <= 2) return points.slice(0, count * stride)

  const keep = new Uint8Array(count)
  keep[0] = 1
  keep[count - 1] = 1

  const epsilonSq = epsilon * epsilon

  // Explicit stack of [first, last] index pairs, in place of recursion.
  const stack: number[] = [0, count - 1]
  while (stack.length > 0) {
    const last = stack.pop()!
    const first = stack.pop()!
    if (last - first < 2) continue

    const x1 = points[first * stride]!
    const y1 = points[first * stride + 1]!
    const x2 = points[last * stride]!
    const y2 = points[last * stride + 1]!

    let worstIdx = -1
    let worstDistSq = epsilonSq
    for (let i = first + 1; i < last; i++) {
      const d = distanceToSegmentSq(
        points[i * stride]!,
        points[i * stride + 1]!,
        x1,
        y1,
        x2,
        y2,
      )
      if (d > worstDistSq) {
        worstDistSq = d
        worstIdx = i
      }
    }

    // Every interior point is within ε of the chord, so the chord replaces
    // all of them. Otherwise split at the worst offender and recheck both
    // halves — that point must be kept.
    if (worstIdx !== -1) {
      keep[worstIdx] = 1
      stack.push(first, worstIdx, worstIdx, last)
    }
  }

  const out: number[] = []
  for (let i = 0; i < count; i++) {
    if (!keep[i]) continue
    const base = i * stride
    out.push(points[base]!, points[base + 1]!, points[base + 2]!)
  }
  return out
}

/**
 * Axis-aligned bounding box of a stroke, inflated by half the stroke width.
 *
 * The inflation matters: `lineWidth` straddles the path, and with round caps
 * and joins the painted pixels extend `strokeWidth / 2` beyond the point
 * coordinates on every side. A box built from the raw points would cull a
 * stroke while part of it is still on screen, and (Phase 4) would refuse a
 * click on its own visible edge.
 */
export function strokeBounds(points: readonly number[], strokeWidth: number): Rect {
  const stride = STROKE_POINT_STRIDE
  const count = Math.floor(points.length / stride)
  if (count === 0) return { x: 0, y: 0, width: 0, height: 0 }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < count; i++) {
    const x = points[i * stride]!
    const y = points[i * stride + 1]!
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }

  const pad = strokeWidth / 2
  return {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + strokeWidth,
    height: maxY - minY + strokeWidth,
  }
}
