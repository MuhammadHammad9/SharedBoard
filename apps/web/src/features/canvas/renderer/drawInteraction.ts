import type { Viewport } from '@coboard/shared'

/**
 * Layer 2 — the in-progress interaction.
 *
 * Contents (FLOWS §14.3): the in-progress stroke, the marquee rectangle, drag
 * previews, alignment guides. Redraws on every pointermove during an
 * interaction.
 *
 * Empty in Phase 2 — nothing is drawn until the pen tool arrives in Phase 3.
 * The layer is mounted and wired now so the z-order and the dirty-flag
 * plumbing are settled before anything depends on them.
 */

export interface DrawLayerArgs {
  viewport: Viewport
  width: number
  height: number
  dpr: number
}

export function drawInteraction(ctx: CanvasRenderingContext2D, args: DrawLayerArgs): void {
  const { width, height, dpr } = args
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.restore()
}
