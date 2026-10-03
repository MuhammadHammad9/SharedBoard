import type { ImageObject } from '@coboard/shared'
import type { ImageSource } from '../../imageCache.js'

/**
 * An image object — FR-CANVAS-010.
 *
 * While the bitmap loads, or if it failed, the object's box is filled with a
 * neutral tone so the layout never jumps and the object stays visible and
 * selectable. No spinner on the canvas: the canvas is a no-decoration zone
 * (R-MOTION-004); progress for an upload in flight is the DOM placeholder's.
 */

/** PRD §15 --color-border. */
const PENDING_FILL = '#E4E4E7'

export function drawImageObject(
  ctx: CanvasRenderingContext2D,
  o: ImageObject,
  images: ImageSource,
): void {
  const bitmap = images.get(o.url)
  const radius = Math.min(o.cornerRadius, o.width / 2, o.height / 2)

  ctx.save()
  if (radius > 0) {
    ctx.beginPath()
    ctx.roundRect(o.x, o.y, o.width, o.height, radius)
    ctx.clip()
  }
  if (bitmap) {
    ctx.globalAlpha = o.opacity
    ctx.drawImage(bitmap, o.x, o.y, o.width, o.height)
  } else {
    ctx.globalAlpha = 0.85
    ctx.fillStyle = PENDING_FILL
    ctx.fillRect(o.x, o.y, o.width, o.height)
  }
  ctx.restore()
}
