import type { Rect, Viewport } from '@coboard/shared'
import {
  HANDLE_SIZE_PX,
  RESIZE_HANDLES,
  ROTATE_HANDLE_OFFSET_PX,
  handleCentre,
} from '../geometry/bounds.js'

/**
 * Layer 3 — the selection overlay.
 *
 * Contents (FLOWS §14.3): selection boxes, resize handles, remote cursors,
 * remote selections, remote in-progress strokes. Phase 4 draws the local
 * selection; Phase 10 adds the remote ones.
 *
 * R-CANVAS-002 (Blocking): this layer redraws independently of layer 1. That
 * separation is what will let a remote cursor move at 20 Hz in Phase 10
 * without repainting 10,000 committed objects — and already lets the rotate
 * readout update per frame for free.
 *
 * MOTION: none. Selection is the single most frequent interaction in the
 * product, which puts it in the top band of the R-MOTION-001 frequency gate.
 * The bounding box appears the instant the object is selected — no fade, no
 * handle pop, no snap animation.
 *
 * Everything here is sized in SCREEN pixels and drawn UNTRANSFORMED, then
 * positioned by converting canvas coordinates by hand. Applying the viewport
 * transform would scale the 1 px outline and the 8 px handles with the zoom,
 * making them hairlines at 10% and slabs at 500% — E-11's exact complaint.
 */

/** PRD §15 tokens. Hard-coded here because a canvas cannot read a CSS var. */
const ACCENT = '#4F46E5'
const WHITE = '#FFFFFF'
const TEXT_PRIMARY = '#18181B'

export interface DrawOverlayArgs {
  viewport: Viewport
  width: number
  height: number
  dpr: number
  /** Selection box in CANVAS coordinates, or null. */
  selectionBox?: Rect | null
  /** Show the 8 resize handles and the rotate handle. */
  showHandles?: boolean
  /** Live rotation readout in degrees while ROTATING, else null. */
  rotationDeg?: number | null
}

export function drawOverlay(ctx: CanvasRenderingContext2D, args: DrawOverlayArgs): void {
  const { viewport, width, height, dpr, selectionBox, showHandles, rotationDeg } = args

  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  if (!selectionBox) {
    ctx.restore()
    return
  }

  // Canvas → screen, done per-point rather than by transforming the context.
  const sx = (x: number) => x * viewport.zoom + viewport.x
  const sy = (y: number) => y * viewport.zoom + viewport.y

  const left = sx(selectionBox.x)
  const top = sy(selectionBox.y)
  const boxW = selectionBox.width * viewport.zoom
  const boxH = selectionBox.height * viewport.zoom

  // 1 px accent outline. The 0.5 offset puts the stroke on a pixel centre
  // instead of straddling two, which is the difference between a crisp line
  // and a blurry two-pixel smear (TRD §7.6).
  ctx.strokeStyle = ACCENT
  ctx.lineWidth = 1
  ctx.strokeRect(
    Math.round(left) + 0.5,
    Math.round(top) + 0.5,
    Math.round(boxW),
    Math.round(boxH),
  )

  if (!showHandles) {
    ctx.restore()
    return
  }

  // Rotate handle: a connecting line up from the top edge, then the knob.
  const rotateC = handleCentre(selectionBox, 'rotate', viewport.zoom)
  const rotateX = sx(rotateC.x)
  const rotateY = sy(rotateC.y)

  ctx.beginPath()
  ctx.moveTo(Math.round(left + boxW / 2) + 0.5, Math.round(top) + 0.5)
  ctx.lineTo(Math.round(rotateX) + 0.5, Math.round(rotateY) + 0.5)
  ctx.stroke()

  ctx.fillStyle = WHITE
  ctx.beginPath()
  ctx.arc(rotateX, rotateY, HANDLE_SIZE_PX / 2, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()

  // The eight resize handles: white fill, 1 px accent border, --radius-sm.
  const half = HANDLE_SIZE_PX / 2
  for (const handle of RESIZE_HANDLES) {
    const c = handleCentre(selectionBox, handle, viewport.zoom)
    const hx = Math.round(sx(c.x) - half) + 0.5
    const hy = Math.round(sy(c.y) - half) + 0.5
    ctx.fillStyle = WHITE
    ctx.beginPath()
    ctx.roundRect(hx, hy, HANDLE_SIZE_PX, HANDLE_SIZE_PX, 2)
    ctx.fill()
    ctx.stroke()
  }

  // Live degree readout while rotating — FLOWS §8.2.3.
  if (rotationDeg !== null && rotationDeg !== undefined) {
    const label = `${Math.round(rotationDeg)}°`
    ctx.font = '12px Inter, system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    const padX = 6
    const textW = ctx.measureText(label).width
    const boxWidth = textW + padX * 2
    const labelY = rotateY - ROTATE_HANDLE_OFFSET_PX

    ctx.fillStyle = TEXT_PRIMARY
    ctx.beginPath()
    ctx.roundRect(rotateX - boxWidth / 2, labelY - 10, boxWidth, 20, 4)
    ctx.fill()

    ctx.fillStyle = WHITE
    ctx.fillText(label, rotateX, labelY)
  }

  ctx.restore()
}
