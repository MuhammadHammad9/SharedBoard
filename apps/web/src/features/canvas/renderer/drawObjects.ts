import {
  POLYLINE_ZOOM_THRESHOLD,
  type BoardObject,
  type ObjectType,
  type StrokeObject,
  type Viewport,
} from '@coboard/shared'
import { collectVisible, getViewRect } from '../geometry/culling.js'
import { applyStrokeStyle, strokePath, strokeStyleKey } from './shapes/stroke.js'

/**
 * Layer 1 — committed objects.
 *
 * PHASE 3 SCOPE: strokes render for real (TRD §7.5, quadratic curves through
 * midpoints). The other seven types still draw as tinted bounding boxes — the
 * transitional BLOCKOUT renderer Phase 2 added so the 10,000-object frame-rate
 * gate could be measured honestly. Shapes and sticky notes replace their
 * blockout in Phase 5, text and images in Phase 5 and 12.
 *
 * R-CANVAS-021: apply the viewport transform ONCE per frame, not per object.
 * R-CANVAS-024: never allocate inside the draw loop.
 * R-CANVAS-023: never call getImageData in the render path.
 *
 * ── Ordering and batching, and why they are in tension ──────────────────────
 *
 * R-CONV-009 requires objects to render in z-order: `sortedIds` is the painter's
 * algorithm and two overlapping opaque strokes must resolve the same way on
 * every client, or the boards have visibly diverged even though the data
 * agrees.
 *
 * TRD §7.6 says to "sort visible objects by strokeStyle/fillStyle and set the
 * context property only when it changes". Taken literally that REORDERS the
 * draw sequence by style, which breaks the above. Recorded as defect D-5 in
 * RULES.md §2.4.
 *
 * What this does instead is RUN-LENGTH batching: iterate strictly in z-order
 * and write context state only when the style key differs from the previous
 * object. Consecutive strokes on a real board usually share a colour and width
 * — a user draws several marks with one pen setting before changing it — so
 * this captures most of the saving at zero correctness cost.
 */

export interface DrawObjectsArgs {
  viewport: Viewport
  width: number
  height: number
  dpr: number
  /** Objects in z-order — R-CONV-009. The renderer never sorts. */
  objects: Iterable<BoardObject>
  /** Reused scratch array so culling allocates nothing per frame. */
  scratch: BoardObject[]
}

/**
 * Blockout tints for the types that have no real renderer yet. Phase 5 deletes
 * the entries it replaces; the palette exists only so the stress board is
 * legible while we measure.
 */
const TINTS: Partial<Record<ObjectType, string>> = {
  rect: '#3B82F6',
  ellipse: '#22C55E',
  line: '#71717A',
  arrow: '#A855F7',
  sticky: '#FEF08A',
  text: '#18181B',
  image: '#E4E4E7',
}

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

  // R-CANVAS-027: below 25% zoom the curvature is sub-pixel. Straight segments
  // are indistinguishable and cheaper.
  const coarse = viewport.zoom < POLYLINE_ZOOM_THRESHOLD

  // Run-length batching state. Empty string can never equal a real key, which
  // always contains two pipes.
  let styleKey = ''
  let blockoutTint = ''

  for (let i = 0; i < visible.length; i++) {
    const o = visible[i]!

    if (o.type === 'stroke') {
      const s = o as StrokeObject
      const key = strokeStyleKey(s)
      if (key !== styleKey) {
        applyStrokeStyle(ctx, s)
        styleKey = key
        // A fill-styled blockout may follow; force it to re-set its own state.
        blockoutTint = ''
      }
      strokePath(ctx, s.points, coarse)
      continue
    }

    const tint = TINTS[o.type]
    if (!tint) continue
    if (tint !== blockoutTint) {
      ctx.fillStyle = tint
      ctx.globalAlpha = coarse ? 0.7 : 0.85
      blockoutTint = tint
      styleKey = ''
    }
    ctx.fillRect(o.x, o.y, o.width, o.height)
  }

  ctx.globalAlpha = 1
  ctx.restore()
}
