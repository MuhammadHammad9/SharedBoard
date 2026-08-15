import {
  POLYLINE_ZOOM_THRESHOLD,
  type BoardObject,
  type ObjectType,
  type Viewport,
} from '@coboard/shared'
import { collectVisible, getViewRect } from '../geometry/culling.js'

/**
 * Layer 1 — committed objects.
 *
 * PHASE 2 SCOPE: this is a deliberately transitional BLOCKOUT renderer. Each
 * object is drawn as its bounding box, tinted by type. Real stroke rendering
 * (quadratic curves through midpoints, TRD §7.5) lands in Phase 3; shapes,
 * sticky notes and text in Phase 5.
 *
 * It exists now because Phase 2's exit gate is "≥55 fps panning the 10,000
 * object stress board", and that cannot be measured honestly without drawing
 * something for 10,000 objects. It exercises the parts this phase is
 * responsible for — culling, the once-per-frame transform, and style batching.
 *
 * R-CANVAS-021: apply the viewport transform ONCE per frame, not per object.
 * R-CANVAS-022: batch by style. Context state changes are ~40% of frame cost
 *               at 5,000 objects (TRD §12.1).
 * R-CANVAS-024: never allocate inside the draw loop.
 * R-CANVAS-023: never call getImageData in the render path.
 */

export interface DrawObjectsArgs {
  viewport: Viewport
  width: number
  height: number
  dpr: number
  objects: Iterable<BoardObject>
  /** Reused scratch array so culling allocates nothing per frame. */
  scratch: BoardObject[]
}

/**
 * Blockout tints. Phase 3+ replaces this with each object's real style; the
 * palette here is only so the stress board is legible while we measure.
 */
const TINTS: Record<ObjectType, string> = {
  stroke: '#18181B',
  rect: '#3B82F6',
  ellipse: '#22C55E',
  line: '#71717A',
  arrow: '#A855F7',
  sticky: '#FEF08A',
  text: '#18181B',
  image: '#E4E4E7',
}

const TYPE_ORDER: readonly ObjectType[] = [
  'image',
  'sticky',
  'rect',
  'ellipse',
  'line',
  'arrow',
  'stroke',
  'text',
]

export function drawObjects(ctx: CanvasRenderingContext2D, args: DrawObjectsArgs): void {
  const { viewport, width, height, dpr, objects, scratch } = args

  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  const visible = collectVisible(objects, getViewRect(viewport, width, height), scratch)
  if (visible.length === 0) {
    ctx.restore()
    return
  }

  // Transform applied once, then every object is drawn in CANVAS coordinates.
  ctx.translate(viewport.x, viewport.y)
  ctx.scale(viewport.zoom, viewport.zoom)

  // Hairlines must stay hairlines as we zoom, so divide by the scale.
  ctx.lineWidth = 1 / viewport.zoom

  // R-CANVAS-027: below 25% zoom, detail is invisible. Skip outlines entirely
  // rather than paying for two passes per object.
  const coarse = viewport.zoom < POLYLINE_ZOOM_THRESHOLD

  // Style batching: one pass per type, so fillStyle is set 8 times per frame
  // rather than once per object.
  for (const type of TYPE_ORDER) {
    let opened = false
    for (let i = 0; i < visible.length; i++) {
      const o = visible[i]!
      if (o.type !== type) continue
      if (!opened) {
        ctx.fillStyle = TINTS[type]
        ctx.globalAlpha = coarse ? 0.7 : 0.85
        opened = true
      }
      ctx.fillRect(o.x, o.y, o.width, o.height)
    }
  }

  ctx.globalAlpha = 1
  ctx.restore()
}
