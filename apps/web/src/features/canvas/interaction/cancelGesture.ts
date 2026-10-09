import { boardStore } from '../../../stores/boardStore.js'
import { cancelDraw } from './handlers/draw.js'
import { cancelDrag, cancelResize, cancelRotate } from './handlers/transform.js'
import { cancelCreate } from './handlers/create.js'
import { cancelErase } from './handlers/erase.js'
import { cancelMarquee } from './handlers/select.js'
import { endPan } from './handlers/pan.js'

/**
 * Unwind whatever gesture is in progress, committing nothing — R-CANVAS-055.
 *
 * One switch shared by Escape and by a live demotion to viewer (FLOWS §9.5),
 * so the two can never disagree about what "cancel" means:
 *
 *   DRAWING              stroke discarded, its presence `done` still sent
 *   DRAGGING/RESIZING/
 *   ROTATING             geometry back to pointerdown
 *   CREATING             nothing created
 *   ERASING              the swept objects come back
 *   MARQUEEING           selection back to what Shift was extending
 *   PANNING              the pan simply ends
 *
 * Every branch releases pointer capture (R-CANVAS-053). Text editing is not a
 * pointer gesture and is left to its own overlay.
 *
 * Lives here rather than in the store: the handlers import the store, so the
 * store importing them back would be a cycle.
 */

/** The canvas element holding pointer capture, registered by Canvas.tsx. */
let gestureElement: Element | null = null

export function setGestureElement(element: Element | null): void {
  gestureElement = element
}

/** Returns true when a gesture was in progress and has been cancelled. */
export function cancelActiveGesture(element: Element | null = gestureElement): boolean {
  switch (boardStore.getState().interaction.type) {
    case 'DRAWING':
      cancelDraw(element)
      return true
    case 'DRAGGING':
      cancelDrag(element)
      return true
    case 'RESIZING':
      cancelResize(element)
      return true
    case 'ROTATING':
      cancelRotate(element)
      return true
    case 'CREATING':
      cancelCreate(element)
      return true
    case 'ERASING':
      cancelErase(element)
      return true
    case 'MARQUEEING':
      cancelMarquee(element)
      return true
    case 'PANNING':
      endPan(element)
      return true
    default:
      return false
  }
}

/**
 * Enter or leave viewer mode. Becoming a viewer mid-gesture cancels the
 * gesture FIRST, through the same path as Escape — so a drag is put back, an
 * erase is undone, a stroke's preview is withdrawn for everyone and capture is
 * released — and only then does the store go read-only.
 */
export function setBoardReadOnly(readOnly: boolean): void {
  if (readOnly && !boardStore.getState().readOnly) cancelActiveGesture()
  boardStore.getState().setReadOnly(readOnly)
}
