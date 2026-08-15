import {
  HIT_TOLERANCE_PX,
  distanceToPolylineSq,
  distanceToSegmentSq,
  pointInEllipse,
  pointInRect,
  rotatedBounds,
  toLocalSpace,
  type BoardObject,
  type ObjectId,
  type Rect,
  type StrokeObject,
} from '@coboard/shared'

/**
 * Hit testing — TRD §7.7, R-CANVAS-040/041/042.
 *
 * Two phases, and the ordering is the whole optimisation:
 *
 *   1. Cheap AABB rejection against the object's (rotation-aware) bounds.
 *   2. A precise per-type test, only for what survives phase 1.
 *
 * Iterated in REVERSE z-order so the topmost object wins — the same order the
 * painter's algorithm drew them in, run backwards. Anything else and clicking
 * an object that is visibly on top selects the one underneath.
 */

/**
 * Screen-space tolerance converted to canvas units — R-CANVAS-041.
 *
 * This term is why a 1 px line is still selectable at 10% zoom. Without it the
 * user is asked to click a target one tenth of a pixel wide, which is not a
 * usability nicety but a straightforward impossibility.
 */
export const toleranceFor = (zoom: number): number => HIT_TOLERANCE_PX / zoom

/** The object's own rect, ignoring rotation. */
const rectOf = (o: BoardObject): Rect => ({
  x: o.x,
  y: o.y,
  width: o.width,
  height: o.height,
})

/**
 * Precise, type-specific containment. `point` is already in the object's local
 * space, so every test here is axis-aligned (R-CANVAS-042).
 */
function preciseHitTest(
  px: number,
  py: number,
  o: BoardObject,
  tolerance: number,
): boolean {
  const r = rectOf(o)

  switch (o.type) {
    case 'ellipse':
      return pointInEllipse(px, py, r)

    case 'line':
    case 'arrow': {
      // A line's geometry is its bounding box diagonal. Phase 5 gives shapes a
      // real endpoint representation; until then the diagonal is what is drawn.
      const reach = o.strokeWidth / 2 + tolerance
      return (
        distanceToSegmentSq(px, py, r.x, r.y, r.x + r.width, r.y + r.height) <=
        reach * reach
      )
    }

    case 'stroke': {
      const s = o as StrokeObject
      const reach = s.strokeWidth / 2 + tolerance
      const reachSq = reach * reach
      return distanceToPolylineSq(px, py, s.points, reachSq) <= reachSq
    }

    // rect, sticky, image, text — the bounding box IS the shape. A
    // corner-radius refinement matters only for large radii and lands with
    // rounded rects in Phase 5.
    default:
      return pointInRect(px, py, r)
  }
}

/** Does this single object contain the point? Exposed for marquee and tests. */
export function hitsObject(
  px: number,
  py: number,
  o: BoardObject,
  zoom: number,
): boolean {
  const tolerance = toleranceFor(zoom)

  // Phase 1 — cheap rejection, padded so a thin stroke's tolerance band is not
  // rejected before the precise test ever sees it.
  const bounds = rotatedBounds(rectOf(o), o.rotation)
  if (
    px < bounds.x - tolerance ||
    px > bounds.x + bounds.width + tolerance ||
    py < bounds.y - tolerance ||
    py > bounds.y + bounds.height + tolerance
  ) {
    return false
  }

  // Phase 2 — rotate the POINT, not the shape, then test axis-aligned.
  const local =
    o.rotation === 0
      ? { x: px, y: py }
      : toLocalSpace(px, py, o.x + o.width / 2, o.y + o.height / 2, o.rotation)

  return preciseHitTest(local.x, local.y, o, tolerance)
}

/**
 * Topmost object under the point, or null.
 *
 * `objects` must be in z-order (ascending) — the store's `sortedIds` order.
 * This walks it backwards.
 */
export function hitTest(
  px: number,
  py: number,
  objects: readonly BoardObject[],
  zoom: number,
): BoardObject | null {
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i]!
    if (hitsObject(px, py, o, zoom)) return o
  }
  return null
}

/**
 * Objects FULLY contained by a rectangle — the marquee rule (FLOWS §8.2.3).
 *
 * Fully contained, not merely intersecting: a marquee that grabbed everything
 * it brushed would make it impossible to select a small object sitting on top
 * of a large one, which is the common case on a busy board.
 *
 * Containment is measured against the ROTATED bounds, so a rotated object is
 * only caught when its true visual extent is inside the marquee.
 */
export function objectsInRect(objects: Iterable<BoardObject>, marquee: Rect): ObjectId[] {
  const out: ObjectId[] = []
  const maxX = marquee.x + marquee.width
  const maxY = marquee.y + marquee.height
  for (const o of objects) {
    const b = rotatedBounds(rectOf(o), o.rotation)
    if (
      b.x >= marquee.x &&
      b.y >= marquee.y &&
      b.x + b.width <= maxX &&
      b.y + b.height <= maxY
    ) {
      out.push(o.id)
    }
  }
  return out
}
