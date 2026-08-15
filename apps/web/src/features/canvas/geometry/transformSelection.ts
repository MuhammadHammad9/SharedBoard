import {
  MIN_OBJECT_SIZE,
  STROKE_POINT_STRIDE,
  clampCoord,
  normalizeRotation,
  type BoardObject,
  type Rect,
  type StrokeObject,
} from '@coboard/shared'
import { affectsX, affectsY, anchorFor, type HandleId } from './bounds.js'

/**
 * Resize and rotate maths — FR-CANVAS-012, FR-CANVAS-013, FLOWS §8.2.3.
 *
 * Deliberately pure functions over plain data, with no store and no DOM. The
 * Shift/Alt/clamp interactions are where resize bugs live, and a pure function
 * is the only version of this that can be exhaustively unit-tested without
 * driving a pointer.
 */

export interface ResizeModifiers {
  /** Preserve the original aspect ratio. */
  aspect: boolean
  /** Resize about the centre rather than the opposite handle. */
  fromCentre: boolean
}

/**
 * The new selection box for a resize drag.
 *
 * `start` is the box as it was at pointerdown — always the original, never the
 * previous frame's result, so a drag cannot accumulate rounding error into a
 * visible drift over a long gesture.
 */
export function resizeBox(
  start: Rect,
  handle: HandleId,
  pointerX: number,
  pointerY: number,
  mods: ResizeModifiers,
): Rect {
  if (handle === 'rotate') return start

  const anchor = mods.fromCentre
    ? { x: start.x + start.width / 2, y: start.y + start.height / 2 }
    : anchorFor(start, handle)

  const movesX = affectsX(handle)
  const movesY = affectsY(handle)

  // Distance from the anchor to the pointer, per axis. From the centre, the
  // box grows both ways, so the half-extent is the full distance.
  let width = movesX ? Math.abs(pointerX - anchor.x) : start.width
  let height = movesY ? Math.abs(pointerY - anchor.y) : start.height
  if (mods.fromCentre) {
    if (movesX) width *= 2
    if (movesY) height *= 2
  }

  if (mods.aspect && start.width > 0 && start.height > 0) {
    const ratio = start.width / start.height
    if (movesX && movesY) {
      // Corner: the larger relative change wins, so the box tracks whichever
      // direction the user is actually pulling.
      if (width / ratio > height) height = width / ratio
      else width = height * ratio
    } else if (movesX) {
      height = width / ratio
    } else {
      width = height * ratio
    }
  }

  // FR-CANVAS-012: minimum 8x8 in canvas coordinates. Clamped, never negative
  // and never flipped — flipping is not a supported operation, and a box that
  // silently inverts produces objects with negative dimensions that fail Zod
  // validation the moment they reach the server in Phase 9.
  width = Math.max(width, MIN_OBJECT_SIZE)
  height = Math.max(height, MIN_OBJECT_SIZE)

  if (mods.fromCentre) {
    return { x: anchor.x - width / 2, y: anchor.y - height / 2, width, height }
  }

  // Place the box so the anchor stays fixed. The pointer's side of the anchor
  // decides which way the box extends.
  const west = movesX
    ? pointerX < anchor.x
    : start.x < anchor.x || handle === 'n' || handle === 's'
  const north = movesY
    ? pointerY < anchor.y
    : start.y < anchor.y || handle === 'e' || handle === 'w'

  return {
    x: movesX ? (west ? anchor.x - width : anchor.x) : start.x,
    y: movesY ? (north ? anchor.y - height : anchor.y) : start.y,
    width,
    height,
  }
}

/**
 * Map one object from an old selection box into a new one.
 *
 * Every object keeps its RELATIVE position and size within the box, which is
 * what makes resizing a multi-selection feel like scaling a group rather than
 * scaling each object about its own centre.
 */
export function applyBoxTransform(o: BoardObject, from: Rect, to: Rect): BoardObject {
  const sx = from.width === 0 ? 1 : to.width / from.width
  const sy = from.height === 0 ? 1 : to.height / from.height

  const x = clampCoord(to.x + (o.x - from.x) * sx)
  const y = clampCoord(to.y + (o.y - from.y) * sy)
  const width = Math.max(o.width * sx, 0)
  const height = Math.max(o.height * sy, 0)

  if (o.type === 'stroke') {
    // FR-CANVAS-012: "freehand strokes scale their point geometry
    // proportionally". Scaling only the bounding box would leave the drawn
    // path unchanged inside a box that no longer matches it.
    const s = o as StrokeObject
    const points = new Array<number>(s.points.length)
    for (let i = 0; i < s.points.length; i += STROKE_POINT_STRIDE) {
      points[i] = clampCoord(to.x + (s.points[i]! - from.x) * sx)
      points[i + 1] = clampCoord(to.y + (s.points[i + 1]! - from.y) * sy)
      // Pressure is not geometry and does not scale.
      points[i + 2] = s.points[i + 2]!
    }
    return { ...s, x, y, width, height, points, updatedAt: Date.now() }
  }

  /*
   * PHASE 5 SLOT — text and sticky notes must REFLOW rather than scale their
   * glyphs (FR-CANVAS-012). Neither type can exist yet, so there is nothing to
   * reflow and nothing to test; the branch lands with those tools. Until then
   * the generic box transform below is correct for every type that exists.
   */
  return { ...o, x, y, width, height, updatedAt: Date.now() }
}

/** Rotation snap in degrees when Shift is held — FR-CANVAS-013. */
export const ROTATE_SNAP_DEG = 15

/**
 * Angle from a box centre to the pointer, in degrees, normalised to [0, 360).
 *
 * Zero points UP, matching the rotate handle's resting position above the box:
 * the handle should sit under the cursor at 0°, not 90° away from it.
 */
export function rotationFor(
  centreX: number,
  centreY: number,
  pointerX: number,
  pointerY: number,
  snap: boolean,
): number {
  const deg = (Math.atan2(pointerY - centreY, pointerX - centreX) * 180) / Math.PI + 90
  const normalised = normalizeRotation(deg)
  return snap
    ? normalizeRotation(Math.round(normalised / ROTATE_SNAP_DEG) * ROTATE_SNAP_DEG)
    : normalised
}

/** Rotate a point about a centre by `deg`. Used to orbit objects in a group. */
function rotatePoint(px: number, py: number, cx: number, cy: number, deg: number) {
  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = px - cx
  const dy = py - cy
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }
}

/**
 * Apply a rotation delta to an object about the selection centre.
 *
 * A single object spins in place. A multi-selection ORBITS: each object's
 * centre travels around the group centre and its own rotation advances by the
 * same delta, which is what makes rotating a group behave like rotating a
 * rigid sheet of paper rather than spinning each object independently.
 */
export function applyRotation(
  o: BoardObject,
  centreX: number,
  centreY: number,
  deltaDeg: number,
): BoardObject {
  const ocx = o.x + o.width / 2
  const ocy = o.y + o.height / 2
  const moved = rotatePoint(ocx, ocy, centreX, centreY, deltaDeg)
  return {
    ...o,
    x: clampCoord(moved.x - o.width / 2),
    y: clampCoord(moved.y - o.height / 2),
    rotation: normalizeRotation(o.rotation + deltaDeg),
    updatedAt: Date.now(),
  }
}

/** Translate an object by a canvas-space delta, clamping coordinates. */
export function translateObject(o: BoardObject, dx: number, dy: number): BoardObject {
  if (o.type === 'stroke') {
    const s = o as StrokeObject
    const points = new Array<number>(s.points.length)
    for (let i = 0; i < s.points.length; i += STROKE_POINT_STRIDE) {
      points[i] = clampCoord(s.points[i]! + dx)
      points[i + 1] = clampCoord(s.points[i + 1]! + dy)
      points[i + 2] = s.points[i + 2]!
    }
    return {
      ...s,
      x: clampCoord(s.x + dx),
      y: clampCoord(s.y + dy),
      points,
      updatedAt: Date.now(),
    }
  }
  return { ...o, x: clampCoord(o.x + dx), y: clampCoord(o.y + dy), updatedAt: Date.now() }
}
