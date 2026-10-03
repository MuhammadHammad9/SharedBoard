import {
  EXPORT_CHUNK_THRESHOLD,
  EXPORT_MAX_DIMENSION,
  type BoardObject,
  type Rect,
} from '@coboard/shared'
import { selectionBounds } from '../canvas/geometry/bounds.js'
import { drawObjects } from '../canvas/renderer/drawObjects.js'
import { imageCache, type ImageCache } from '../canvas/imageCache.js'

/**
 * Board → PNG pixels — FLOWS §11, FR-EXPORT-001, Phase 13 tasks 2–4.
 *
 * The same `drawObjects` the live canvas uses, on an offscreen canvas, with a
 * viewport that maps the export rectangle onto it. One renderer, so an export
 * can never disagree with what the board shows.
 */

export type ExportScope = 'board' | 'selection' | 'visible'

export interface ExportOptions {
  scope: ExportScope
  scale: 1 | 2
  transparent: boolean
  /** Canvas units of margin around the content. */
  padding: number
}

/** PRD §15 --color-bg-canvas, for a non-transparent export. */
const CANVAS_BG = '#FAFAFA'

/** The largest area an export may have — FLOWS §11 "8192×8192". */
const MAX_PIXELS = EXPORT_MAX_DIMENSION * EXPORT_MAX_DIMENSION

/** Objects per rAF chunk on a large board (FLOWS §11). */
const CHUNK = 500

const intersects = (o: BoardObject, r: Rect) =>
  o.x + o.width >= r.x &&
  o.x <= r.x + r.width &&
  o.y + o.height >= r.y &&
  o.y <= r.y + r.height

/**
 * What an export contains, in z-order, and the rectangle it covers (padding
 * included). Null when there is nothing to export — E-22.
 *
 *   board      every object; the union of their bounds
 *   selection  the selected objects; their bounds
 *   visible    the objects touching the view; the view ITSELF, so the PNG is
 *              what the user is looking at, framing and all
 */
export function exportContent(
  scope: ExportScope,
  objectsInZOrder: readonly BoardObject[],
  selection: ReadonlySet<string>,
  visible: Rect,
  padding: number,
): { objects: BoardObject[]; rect: Rect } | null {
  const objects =
    scope === 'selection'
      ? objectsInZOrder.filter(o => selection.has(o.id))
      : scope === 'visible'
        ? objectsInZOrder.filter(o => intersects(o, visible))
        : [...objectsInZOrder]
  if (objects.length === 0) return null

  if (scope === 'visible') return { objects, rect: visible }
  const box = selectionBounds(objects)!
  return {
    objects,
    rect: {
      x: box.x - padding,
      y: box.y - padding,
      width: box.width + padding * 2,
      height: box.height + padding * 2,
    },
  }
}

/**
 * The scale actually used, after the 8192² clamp. `clamped` drives the
 * "Scaled down to fit the maximum export size." warning.
 */
export function clampScale(
  rect: Rect,
  requested: number,
): { scale: number; clamped: boolean } {
  const pixels = rect.width * requested * (rect.height * requested)
  if (pixels <= MAX_PIXELS) return { scale: requested, clamped: false }
  return { scale: Math.sqrt(MAX_PIXELS / (rect.width * rect.height)), clamped: true }
}

export interface RenderArgs {
  objects: readonly BoardObject[]
  rect: Rect
  scale: number
  transparent: boolean
  /** 0…1, for boards over the chunk threshold. */
  onProgress?: (fraction: number) => void
  images?: ImageCache
  /** Injected in tests; a real canvas otherwise. */
  createCanvas?: (width: number, height: number) => HTMLCanvasElement
}

const nextFrame = () =>
  new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

export async function renderExport(args: RenderArgs): Promise<HTMLCanvasElement> {
  const { objects, rect, scale, transparent } = args
  const images = args.images ?? imageCache
  const width = Math.max(1, Math.ceil(rect.width * scale))
  const height = Math.max(1, Math.ceil(rect.height * scale))
  const canvas =
    args.createCanvas?.(width, height) ??
    Object.assign(document.createElement('canvas'), { width, height })
  const ctx = canvas.getContext('2d')!

  // Every image in the export decoded first, or the PNG has grey boxes in it.
  const urls = new Set<string>()
  for (const o of objects) if (o.type === 'image') urls.add(o.url)
  await Promise.all([...urls].map(url => images.whenSettled(url)))

  if (!transparent) {
    ctx.fillStyle = CANVAS_BG
    ctx.fillRect(0, 0, width, height)
  }

  const viewport = { x: -rect.x * scale, y: -rect.y * scale, zoom: scale }
  const scratch: BoardObject[] = []
  const draw = (batch: readonly BoardObject[]) =>
    drawObjects(ctx, {
      viewport,
      width,
      height,
      dpr: 1,
      objects: batch,
      scratch,
      images,
      clear: false,
    })

  if (objects.length <= EXPORT_CHUNK_THRESHOLD) {
    draw(objects)
    args.onProgress?.(1)
    return canvas
  }

  // FLOWS §11: over 2,000 objects, render in chunks and yield to the frame
  // between them, so the UI keeps painting and the progress bar moves.
  for (let i = 0; i < objects.length; i += CHUNK) {
    draw(objects.slice(i, i + CHUNK))
    args.onProgress?.(Math.min(1, (i + CHUNK) / objects.length))
    await nextFrame()
  }
  return canvas
}

export const toPngBlob = (canvas: HTMLCanvasElement): Promise<Blob> =>
  new Promise((resolve, reject) =>
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('toBlob failed'))),
      'image/png',
    ),
  )
