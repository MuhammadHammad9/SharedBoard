import type { DrawLayerArgs } from './drawInteraction.js'

/**
 * Layer 3 — the overlay.
 *
 * Contents (FLOWS §14.3): selection boxes, resize handles, remote cursors,
 * remote selections, remote in-progress strokes.
 *
 * Empty in Phase 2. Selection arrives in Phase 4, remote presence in Phase 10.
 *
 * R-CANVAS-002 (Blocking) — the rule this separation exists for: when Phase 10
 * starts drawing remote cursors here at 20 Hz, marking THIS layer dirty must
 * never cause layer 1 to redraw. If moving a mouse in one window drops the
 * frame rate in another, the layering is wrong. The isolation test in
 * __tests__/Renderer.test.ts guards it from now on.
 */
export function drawOverlay(ctx: CanvasRenderingContext2D, args: DrawLayerArgs): void {
  const { width, height, dpr } = args
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.restore()
}
