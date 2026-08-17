import type { ShapeObject } from '@coboard/shared'

/**
 * Shape renderers — FR-CANVAS-007, TRD §3.3.
 *
 * rect, ellipse, line and arrow. All four are defined by their bounding box,
 * which is what makes them uniform to select, resize and rotate: `line` and
 * `arrow` are simply the box's top-left → bottom-right diagonal, matching the
 * hit test written in Phase 4.
 *
 * Each takes the context already transformed into canvas space and already
 * carrying the object's style, so `drawObjects` can batch a run of same-styled
 * shapes behind one set of context writes (R-CANVAS-022).
 */

/** Style key for run-length batching, mirroring `strokeStyleKey`. */
export const shapeStyleKey = (s: ShapeObject): string =>
  `${s.stroke}|${s.strokeWidth}|${s.fill}|${s.opacity}`

export function applyShapeStyle(ctx: CanvasRenderingContext2D, s: ShapeObject): void {
  ctx.strokeStyle = s.stroke
  ctx.lineWidth = s.strokeWidth
  ctx.globalAlpha = s.opacity
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (s.fill !== 'none') ctx.fillStyle = s.fill
}

/** Arrowhead length as a multiple of stroke width, clamped so it stays sane. */
const arrowHeadFor = (strokeWidth: number): number => Math.max(8, strokeWidth * 3)

function path(ctx: CanvasRenderingContext2D, s: ShapeObject): void {
  const { x, y, width: w, height: h } = s

  switch (s.type) {
    case 'rect': {
      ctx.beginPath()
      // A radius larger than half the shorter side produces a self-
      // intersecting path in some engines; clamp rather than trust the input.
      const r = Math.min(s.cornerRadius ?? 0, Math.min(w, h) / 2)
      if (r > 0) ctx.roundRect(x, y, w, h, r)
      else ctx.rect(x, y, w, h)
      return
    }

    case 'ellipse': {
      ctx.beginPath()
      ctx.ellipse(
        x + w / 2,
        y + h / 2,
        Math.abs(w / 2),
        Math.abs(h / 2),
        0,
        0,
        Math.PI * 2,
      )
      return
    }

    case 'line':
    case 'arrow': {
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x + w, y + h)
      return
    }
  }
}

/** The two barbs of an arrowhead at `(tipX, tipY)`, pointing away from the tail. */
function arrowHead(
  ctx: CanvasRenderingContext2D,
  tipX: number,
  tipY: number,
  fromX: number,
  fromY: number,
  size: number,
): void {
  const angle = Math.atan2(tipY - fromY, tipX - fromX)
  const spread = Math.PI / 7

  ctx.beginPath()
  ctx.moveTo(
    tipX - size * Math.cos(angle - spread),
    tipY - size * Math.sin(angle - spread),
  )
  ctx.lineTo(tipX, tipY)
  ctx.lineTo(
    tipX - size * Math.cos(angle + spread),
    tipY - size * Math.sin(angle + spread),
  )
  ctx.stroke()
}

/**
 * Draw a shape. Style must already be applied by the caller.
 *
 * Fill first, then stroke — a stroke straddles the path, so filling afterwards
 * would paint over the inner half of it and make every outline look thinner
 * than its declared width.
 */
export function drawShape(ctx: CanvasRenderingContext2D, s: ShapeObject): void {
  const closed = s.type === 'rect' || s.type === 'ellipse'

  path(ctx, s)
  if (closed && s.fill !== 'none') ctx.fill()
  if (s.strokeWidth > 0) ctx.stroke()

  if (s.type !== 'arrow' || s.strokeWidth <= 0) return

  const size = arrowHeadFor(s.strokeWidth)
  const x2 = s.x + s.width
  const y2 = s.y + s.height
  // Default to an arrowhead at the end. An arrow with neither end marked is
  // a line, and the user did not pick the line tool.
  const end = s.arrowEnd ?? true
  if (end) arrowHead(ctx, x2, y2, s.x, s.y, size)
  if (s.arrowStart) arrowHead(ctx, s.x, s.y, x2, y2, size)
}
