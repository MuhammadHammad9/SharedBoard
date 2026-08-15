import type { Viewport } from '@coboard/shared'
import { drawStroke } from './shapes/stroke.js'

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
}

export function drawInteraction(ctx: CanvasRenderingContext2D, args: DrawLayerArgs): void {
  const { viewport, width, height, dpr, draft } = args

  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  if (draft && draft.points.length >= 6) {
    // R-CANVAS-021: transform once, then draw in canvas coordinates.
    ctx.translate(viewport.x, viewport.y)
    ctx.scale(viewport.zoom, viewport.zoom)
    drawStroke(ctx, draft, viewport.zoom)
  }

  ctx.restore()
}
