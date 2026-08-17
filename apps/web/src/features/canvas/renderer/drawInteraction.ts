import type { BoardObject, Rect, ShapeObject, Viewport } from '@coboard/shared'
import { drawStroke } from './shapes/stroke.js'
import { applyShapeStyle, drawShape } from './shapes/shapes.js'
import type { Guide } from '../geometry/alignmentGuides.js'

/**
 * Layer 2 — the in-progress interaction.
 *
 * Contents (FLOWS §14.3): the in-progress stroke, the marquee rectangle, drag
 * previews, alignment guides. Redraws on every pointermove during an
 * interaction — and, critically, WITHOUT touching layer 1. Drawing a stroke
 * must not repaint 10,000 committed objects sixty times a second, for exactly
 * the reason a remote cursor must not (R-CANVAS-002).
 *
 * Phase 3 draws the draft stroke. The marquee arrives with selection in
 * Phase 4.
 *
 * The draft goes through the SAME `drawStroke` the object layer uses, so the
 * line does not shift, thin or change colour at the moment it commits. A
 * visible hitch on mouse-up reads as a bug even when the data is correct.
 */

/** The in-flight stroke. Points are mutated in place — R-STATE-002. */
export interface DraftStroke {
  /** Client-generated op/object id, minted on pointerdown — R-SYNC-014. */
  id: string
  /** Flat, stride 3: [x, y, pressure, …] in CANVAS coordinates. */
  points: number[]
  color: string
  strokeWidth: number
  opacity: number
}

export interface DrawLayerArgs {
  viewport: Viewport
  width: number
  height: number
  dpr: number
  draft?: DraftStroke | null
  /** Marquee rectangle in CANVAS coordinates while MARQUEEING — FR-CANVAS-004. */
  marquee?: Rect | null
  /** The shape being drag-defined — FR-CANVAS-007. */
  creating?: BoardObject | null
  /** Active alignment guides — FR-CANVAS-020. */
  guides?: readonly Guide[]
}

/** PRD §15 --color-accent. A canvas cannot read a CSS custom property. */
const ACCENT = '#4F46E5'
/**
 * Alignment guides are PINK, per FR-CANVAS-020, and deliberately NOT the
 * accent colour: a guide is transient feedback about a relationship, not a
 * selection, and it must be instantly distinguishable from the selection box
 * it appears alongside.
 */
const GUIDE_PINK = '#EC4899'

export function drawInteraction(
  ctx: CanvasRenderingContext2D,
  args: DrawLayerArgs,
): void {
  const { viewport, width, height, dpr, draft, marquee, creating, guides } = args

  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  if (draft && draft.points.length >= 6) {
    ctx.save()
    // R-CANVAS-021: transform once, then draw in canvas coordinates.
    ctx.translate(viewport.x, viewport.y)
    ctx.scale(viewport.zoom, viewport.zoom)
    drawStroke(ctx, draft, viewport.zoom)
    ctx.restore()
  }

  /*
   * The marquee lives HERE, on layer 2 — defect D-6.
   *
   * FLOWS §8.2.3 says "marquee rectangle on the overlay layer", but §14.3's
   * layer table explicitly lists "the marquee rectangle" under layer 2. §14.3
   * is the authoritative layer specification and the more specific of the two
   * statements, so it wins. Recorded in RULES.md §2.4.
   *
   * Drawn UNTRANSFORMED in screen space so the 1 px outline stays 1 px at
   * every zoom level.
   */
  if (marquee) {
    const x = marquee.x * viewport.zoom + viewport.x
    const y = marquee.y * viewport.zoom + viewport.y
    const w = marquee.width * viewport.zoom
    const h = marquee.height * viewport.zoom

    ctx.fillStyle = ACCENT
    ctx.globalAlpha = 0.08
    ctx.fillRect(x, y, w, h)

    ctx.globalAlpha = 1
    ctx.strokeStyle = ACCENT
    ctx.lineWidth = 1
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h))
  }

  /*
   * The shape being drag-defined, drawn with the SAME renderer that will draw
   * it once committed. A bespoke preview is a preview that can disagree with
   * the result, and the moment of commit is exactly when the user is looking.
   */
  if (creating) {
    ctx.save()
    ctx.translate(viewport.x, viewport.y)
    ctx.scale(viewport.zoom, viewport.zoom)
    const s = creating as ShapeObject
    applyShapeStyle(ctx, s)
    drawShape(ctx, s)
    ctx.restore()
  }

  /*
   * Alignment guides — FR-CANVAS-020. Instantly, never animated: "a guide that
   * fades in is a guide that arrives after the user needed it."
   *
   * Drawn in screen space so the 1 px line stays 1 px at every zoom.
   */
  if (guides && guides.length > 0) {
    ctx.save()
    ctx.strokeStyle = GUIDE_PINK
    ctx.lineWidth = 1
    for (const g of guides) {
      ctx.beginPath()
      if (g.axis === 'x') {
        const sx = Math.round(g.position * viewport.zoom + viewport.x) + 0.5
        ctx.moveTo(sx, g.from * viewport.zoom + viewport.y)
        ctx.lineTo(sx, g.to * viewport.zoom + viewport.y)
      } else {
        const sy = Math.round(g.position * viewport.zoom + viewport.y) + 0.5
        ctx.moveTo(g.from * viewport.zoom + viewport.x, sy)
        ctx.lineTo(g.to * viewport.zoom + viewport.x, sy)
      }
      ctx.stroke()
    }
    ctx.restore()
  }

  ctx.restore()
}
