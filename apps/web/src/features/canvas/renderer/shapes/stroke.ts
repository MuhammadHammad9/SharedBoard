import { POLYLINE_ZOOM_THRESHOLD, STROKE_POINT_STRIDE, type StrokeObject } from '@coboard/shared'

/**
 * Freehand stroke rendering — TRD §7.5, R-CANVAS-031.
 *
 * Raw pointer points produce visibly polygonal lines. Drawing quadratic curves
 * whose control points are the raw samples and whose endpoints are the
 * MIDPOINTS between consecutive samples gives a C1-continuous curve in a single
 * path, at one `stroke()` call per object. That last part is why this shape and
 * not a fancier one: at 10,000 objects the frame budget is spent on context
 * state changes and path submissions, not on curve mathematics (TRD §12.1).
 *
 * PRESSURE — FR-CANVAS-005 [P1], and a deliberate, agreed scope decision.
 * `points` carries a pressure value per sample (stride 3) and it is captured,
 * clamped, simplified alongside the coordinates and persisted. It is NOT
 * rendered as variable width: TRD §7.5 sets one `lineWidth` for the whole
 * path, and visible taper would mean either a filled outline polygon or one
 * `stroke()` per segment — the second contradicts R-CANVAS-022 outright, and
 * both contradict the explicit code in §7.5, which is Tier 2 authority. The
 * data is stored, so a later phase can render it without a migration.
 */

/**
 * Build and stroke the path. The CALLER sets `strokeStyle`, `lineWidth`,
 * `globalAlpha`, `lineCap` and `lineJoin`, so the object layer can batch a run
 * of same-styled strokes behind a single set of context writes (R-CANVAS-022).
 *
 * `coarse` selects the R-CANVAS-027 fallback: below 25% zoom the curvature is
 * smaller than a pixel, so straight segments are indistinguishable and cheaper.
 */
export function strokePath(
  ctx: CanvasRenderingContext2D,
  points: readonly number[],
  coarse: boolean,
): void {
  const s = STROKE_POINT_STRIDE
  const n = points.length
  // Fewer than two points is not a line. TRD §7.5 guards on p.length < 6.
  if (n < s * 2) return

  ctx.beginPath()
  ctx.moveTo(points[0]!, points[1]!)

  if (coarse) {
    for (let i = s; i < n; i += s) ctx.lineTo(points[i]!, points[i + 1]!)
    ctx.stroke()
    return
  }

  // Each raw sample is a control point; the curve passes through the midpoints.
  for (let i = s; i < n - s; i += s) {
    const midX = (points[i]! + points[i + s]!) / 2
    const midY = (points[i + 1]! + points[i + s + 1]!) / 2
    ctx.quadraticCurveTo(points[i]!, points[i + 1]!, midX, midY)
  }
  // The loop stops one sample short, so close on the true final point —
  // otherwise every stroke ends half a sample early.
  ctx.lineTo(points[n - s]!, points[n - s + 1]!)
  ctx.stroke()
}

/** Style key for run-length batching. Identical keys share context state. */
export const strokeStyleKey = (s: {
  color: string
  strokeWidth: number
  opacity: number
}): string => `${s.color}|${s.strokeWidth}|${s.opacity}`

/** Apply a stroke's context state. Paired with `strokeStyleKey` by the caller. */
export function applyStrokeStyle(
  ctx: CanvasRenderingContext2D,
  s: { color: string; strokeWidth: number; opacity: number },
): void {
  ctx.strokeStyle = s.color
  ctx.lineWidth = s.strokeWidth
  ctx.globalAlpha = s.opacity
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
}

/**
 * Self-contained draw — sets style, then strokes. Used by the interaction
 * layer, where exactly one stroke is in flight and there is nothing to batch
 * against.
 */
export function drawStroke(
  ctx: CanvasRenderingContext2D,
  s: Pick<StrokeObject, 'points' | 'color' | 'strokeWidth' | 'opacity'>,
  zoom: number,
): void {
  applyStrokeStyle(ctx, s)
  strokePath(ctx, s.points, zoom < POLYLINE_ZOOM_THRESHOLD)
  ctx.globalAlpha = 1
}
