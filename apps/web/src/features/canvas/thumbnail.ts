import {
  THUMBNAIL_HEIGHT,
  THUMBNAIL_PADDING_RATIO,
  THUMBNAIL_QUALITY,
  THUMBNAIL_WIDTH,
  type BoardObject,
} from '@coboard/shared'
import { selectionBounds } from './geometry/bounds.js'
import { drawObjects } from './renderer/drawObjects.js'
import { imageCache, type ImageSource } from './imageCache.js'

/**
 * The dashboard's picture of a board — FR-BOARD-003, Phase 13 task 12.
 *
 * 640×400 JPEG at 0.7, framing the bounding box of every object with 5%
 * padding, letterboxed on the canvas colour (JPEG has no transparency).
 * Drawn by the same renderer as the board itself.
 *
 * SYNCHRONOUS end to end — canvas, draw, `toDataURL` — because one of its two
 * moments is the tab closing (`pagehide`), when an async `toBlob` callback may
 * never run. An image still loading at that instant draws as its neutral box;
 * the next thumbnail fixes it.
 *
 * An empty board has no thumbnail: the caller clears it, and the dashboard
 * shows the placeholder graphic instead of a blank rectangle.
 */

/** PRD §15 --color-bg-canvas. */
const BACKGROUND = '#FAFAFA'

export function renderThumbnail(
  objects: readonly BoardObject[],
  images: ImageSource = imageCache,
  createCanvas: () => HTMLCanvasElement = () => document.createElement('canvas'),
): Blob | null {
  const bounds = selectionBounds(objects)
  if (!bounds) return null

  const pad = Math.max(bounds.width, bounds.height) * THUMBNAIL_PADDING_RATIO
  const rect = {
    x: bounds.x - pad,
    y: bounds.y - pad,
    width: Math.max(1, bounds.width + pad * 2),
    height: Math.max(1, bounds.height + pad * 2),
  }
  const zoom = Math.min(THUMBNAIL_WIDTH / rect.width, THUMBNAIL_HEIGHT / rect.height)
  // Centred: the leftover band is split evenly on both sides.
  const viewport = {
    x: (THUMBNAIL_WIDTH - rect.width * zoom) / 2 - rect.x * zoom,
    y: (THUMBNAIL_HEIGHT - rect.height * zoom) / 2 - rect.y * zoom,
    zoom,
  }

  const canvas = createCanvas()
  canvas.width = THUMBNAIL_WIDTH
  canvas.height = THUMBNAIL_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = BACKGROUND
  ctx.fillRect(0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT)
  drawObjects(ctx, {
    viewport,
    width: THUMBNAIL_WIDTH,
    height: THUMBNAIL_HEIGHT,
    dpr: 1,
    objects,
    scratch: [],
    images,
    clear: false,
  })

  try {
    return dataUrlToBlob(canvas.toDataURL('image/jpeg', THUMBNAIL_QUALITY))
  } catch {
    // A tainted canvas (an image served without CORS) cannot be read back.
    return null
  }
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, base64 = ''] = dataUrl.split(',')
  const type = /data:([^;]+)/.exec(head ?? '')?.[1] ?? 'image/jpeg'
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type })
}
