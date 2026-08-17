import {
  POLYLINE_ZOOM_THRESHOLD,
  type BoardObject,
  type ObjectType,
  type ShapeObject,
  type StickyObject,
  type StrokeObject,
  type TextObject,
  type Viewport,
} from '@coboard/shared'
import { collectVisible, getViewRect } from '../geometry/culling.js'
import { applyStrokeStyle, strokePath, strokeStyleKey } from './shapes/stroke.js'
import { applyShapeStyle, drawShape, shapeStyleKey } from './shapes/shapes.js'
import { drawSticky, drawText } from './shapes/textual.js'

/**
 * Layer 1 — committed objects.
 *
 * PHASE 5 SCOPE: strokes, shapes, sticky notes and text all render for real.
 * Only images still draw as a tinted bounding box — the last survivor of the
 * transitional BLOCKOUT renderer Phase 2 added so the 10,000-object frame-rate
 * gate could be measured honestly. FR-CANVAS-010 retires it in Phase 12.
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
  /** Object under the eraser, drawn in --color-danger — FR-CANVAS-006. */
  eraseCandidate?: string | null
}

/** PRD §15 --color-danger. The eraser's "this is what you are about to lose". */
const DANGER = '#DC2626'

/**
 * Blockout tint for the ONE type still without a real renderer.
 *
 * Phase 5 replaced shapes, sticky notes and text; images are FR-CANVAS-010
 * [P1] and land in Phase 12, so the placeholder rectangle survives for them
 * alone. When that goes, so does this and the whole blockout branch below.
 */
const TINTS: Partial<Record<ObjectType, string>> = {
  image: '#E4E4E7',
}

export function drawObjects(ctx: CanvasRenderingContext2D, args: DrawObjectsArgs): void {
  const { viewport, width, height, dpr, objects, scratch, eraseCandidate } = args

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

    /*
     * FR-CANVAS-006: the object under the eraser renders in --color-danger.
     * Drawn outside the batch — it is exactly one object per frame at most, so
     * paying one extra pair of context writes is cheaper than threading a
     * conditional through the batching state, and it keeps the run-length
     * logic below honest about what it is comparing.
     */
    const erasing = eraseCandidate != null && o.id === eraseCandidate

    if (o.type === 'stroke') {
      const s = o as StrokeObject
      if (erasing) {
        ctx.save()
        applyStrokeStyle(ctx, { ...s, color: DANGER })
        strokePath(ctx, s.points, coarse)
        ctx.restore()
        // The batch's cached style is still whatever it was before the save,
        // so nothing needs invalidating here.
        continue
      }
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

    if (erasing) {
      ctx.save()
      ctx.fillStyle = DANGER
      ctx.globalAlpha = 0.85
      ctx.fillRect(o.x, o.y, o.width, o.height)
      ctx.restore()
      continue
    }

    if (
      o.type === 'rect' ||
      o.type === 'ellipse' ||
      o.type === 'line' ||
      o.type === 'arrow'
    ) {
      const s = o as ShapeObject
      const key = shapeStyleKey(s)
      if (key !== styleKey) {
        applyShapeStyle(ctx, s)
        styleKey = key
        blockoutTint = ''
      }
      drawShape(ctx, s)
      continue
    }

    /*
     * Sticky notes and text each save/restore their own context. They set
     * font, alignment, baseline, clip regions and gradients — far more state
     * than a style key can usefully describe, and leaking any of it into the
     * next object would be a rendering bug that only shows up on boards with a
     * particular ordering. Batching is for the cheap uniform cases.
     */
    if (o.type === 'sticky') {
      drawSticky(ctx, o as StickyObject)
      styleKey = ''
      blockoutTint = ''
      continue
    }

    if (o.type === 'text') {
      drawText(ctx, o as TextObject)
      styleKey = ''
      blockoutTint = ''
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
