import {
  MIN_HANDLE_TARGET_PX,
  MIN_HANDLE_TARGET_TOUCH_PX,
  rotatedBounds,
  unionRects,
  type BoardObject,
  type Rect,
} from '@coboard/shared'

/**
 * Selection bounds and handle geometry — FLOWS §8.2.3, §14.2, E-11.
 *
 * Everything here works in CANVAS coordinates for the box and SCREEN pixels
 * for the handles, and the split is deliberate. A handle is an affordance for
 * a finger or a cursor, so its size is a property of the input device, not of
 * the document. Sizing handles in canvas units would make them invisible at
 * 10% zoom and enormous at 500% — the exact bug E-11 describes.
 */

/** The eight resize handles, plus the rotate handle. */
export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate'

export const RESIZE_HANDLES: readonly HandleId[] = [
  'nw',
  'n',
  'ne',
  'e',
  'se',
  's',
  'sw',
  'w',
]

/** Handle side length in SCREEN pixels — R-CANVAS-043. */
export const HANDLE_SIZE_PX = 8

/** Gap between the box's top edge and the rotate handle, in screen pixels. */
export const ROTATE_HANDLE_OFFSET_PX = 24

/** CSS cursor per handle. FLOWS §14.2. */
export const HANDLE_CURSORS: Record<HandleId, string> = {
  nw: 'nwse-resize',
  n: 'ns-resize',
  ne: 'nesw-resize',
  e: 'ew-resize',
  se: 'nwse-resize',
  s: 'ns-resize',
  sw: 'nesw-resize',
  w: 'ew-resize',
  rotate: 'grab',
}

/**
 * Union bounding box of a selection, in canvas coordinates.
 *
 * Uses each object's ROTATED bounds so the box actually encloses what the user
 * can see. Returns null for an empty selection.
 */
export function selectionBounds(objects: readonly BoardObject[]): Rect | null {
  if (objects.length === 0) return null
  return unionRects(
    objects.map(o =>
      rotatedBounds({ x: o.x, y: o.y, width: o.width, height: o.height }, o.rotation),
    ),
  )
}

/** Handle centre in canvas coordinates, given the selection box. */
export function handleCentre(
  box: Rect,
  handle: HandleId,
  zoom: number,
): { x: number; y: number } {
  const midX = box.x + box.width / 2
  const midY = box.y + box.height / 2
  const right = box.x + box.width
  const bottom = box.y + box.height

  switch (handle) {
    case 'nw':
      return { x: box.x, y: box.y }
    case 'n':
      return { x: midX, y: box.y }
    case 'ne':
      return { x: right, y: box.y }
    case 'e':
      return { x: right, y: midY }
    case 'se':
      return { x: right, y: bottom }
    case 's':
      return { x: midX, y: bottom }
    case 'sw':
      return { x: box.x, y: bottom }
    case 'w':
      return { x: box.x, y: midY }
    case 'rotate':
      // Offset in SCREEN pixels, so the handle sits a constant distance above
      // the box no matter how far the user is zoomed in or out.
      return { x: midX, y: box.y - ROTATE_HANDLE_OFFSET_PX / zoom }
  }
}

/**
 * Which handle, if any, is under a canvas-space point.
 *
 * The hit target is a constant number of SCREEN pixels wide (R-CANVAS-043,
 * E-11): 8 on a fine pointer, 44 on touch, where the finger is the limiting
 * factor and Apple's and Google's guidelines both land near 44.
 *
 * Rotate is checked first. It sits outside the box, so it can never be
 * ambiguous with a resize handle — but checking it first means that when the
 * box is very short and the offset overlaps 'n', rotation still wins, which is
 * the less destructive of the two.
 */
export function handleAt(
  px: number,
  py: number,
  box: Rect,
  zoom: number,
  coarsePointer = false,
): HandleId | null {
  const targetPx = coarsePointer ? MIN_HANDLE_TARGET_TOUCH_PX : MIN_HANDLE_TARGET_PX
  const half = Math.max(targetPx, HANDLE_SIZE_PX) / 2 / zoom

  const order: readonly HandleId[] = ['rotate', ...RESIZE_HANDLES]
  for (const handle of order) {
    const c = handleCentre(box, handle, zoom)
    if (Math.abs(px - c.x) <= half && Math.abs(py - c.y) <= half) return handle
  }
  return null
}

/**
 * The anchor a resize pivots around: the opposite corner or edge.
 *
 * Dragging 'se' holds 'nw' still. Edge handles hold the opposite edge but
 * leave the other axis alone, which is what makes an edge drag one-dimensional.
 */
export function anchorFor(box: Rect, handle: HandleId): { x: number; y: number } {
  const right = box.x + box.width
  const bottom = box.y + box.height
  const midX = box.x + box.width / 2
  const midY = box.y + box.height / 2

  switch (handle) {
    case 'nw':
      return { x: right, y: bottom }
    case 'ne':
      return { x: box.x, y: bottom }
    case 'se':
      return { x: box.x, y: box.y }
    case 'sw':
      return { x: right, y: box.y }
    case 'n':
      return { x: midX, y: bottom }
    case 's':
      return { x: midX, y: box.y }
    case 'w':
      return { x: right, y: midY }
    case 'e':
      return { x: box.x, y: midY }
    case 'rotate':
      return { x: midX, y: midY }
  }
}

/** Does this handle move the horizontal axis? Edge handles move only one. */
export const affectsX = (h: HandleId): boolean => h !== 'n' && h !== 's' && h !== 'rotate'
export const affectsY = (h: HandleId): boolean => h !== 'e' && h !== 'w' && h !== 'rotate'
