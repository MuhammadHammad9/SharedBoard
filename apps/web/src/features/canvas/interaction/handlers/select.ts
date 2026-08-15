import {
  clampCoord,
  screenPoint,
  screenToCanvas,
  type ObjectId,
  type Rect,
} from '@coboard/shared'
import {
  boardStore,
  objectsInZOrder,
  selectedObjects,
} from '../../../../stores/boardStore.js'
import { hitTest, objectsInRect } from '../../geometry/hitTest.js'
import { handleAt, selectionBounds, type HandleId } from '../../geometry/bounds.js'
import { canTransition } from '../machine.js'

/**
 * Selection — FR-CANVAS-004, FLOWS §8.2.3.
 *
 * Click to select, Shift+click to toggle, drag empty canvas to marquee, click
 * empty canvas to deselect.
 */

/** Screen → canvas, clamped. R-COORD-004: the conversion lives in one place. */
export function toCanvas(screenX: number, screenY: number): { x: number; y: number } {
  const { viewport } = boardStore.getState()
  const p = screenToCanvas(screenPoint(screenX, screenY), viewport)
  return { x: clampCoord(p.x), y: clampCoord(p.y) }
}

/** The current selection's union box in canvas space, or null. */
export function currentSelectionBox(): Rect | null {
  return selectionBounds(selectedObjects())
}

/**
 * What a pointerdown at this canvas point would act on. Used both to route the
 * pointerdown and to pick the cursor, so the cursor can never promise an
 * interaction the pointerdown will not deliver.
 */
export function probe(
  px: number,
  py: number,
  coarsePointer = false,
):
  | { kind: 'handle'; handle: HandleId }
  | { kind: 'object'; id: ObjectId }
  | { kind: 'empty' } {
  const { viewport, selection } = boardStore.getState()

  // Handles outrank objects: they sit ON the box edge, often directly over the
  // object they belong to, and the user reaching for a corner means resize.
  if (selection.length > 0) {
    const box = currentSelectionBox()
    if (box) {
      const handle = handleAt(px, py, box, viewport.zoom, coarsePointer)
      if (handle) return { kind: 'handle', handle }
    }
  }

  const hit = hitTest(px, py, objectsInZOrder(), viewport.zoom)
  return hit ? { kind: 'object', id: hit.id } : { kind: 'empty' }
}

/**
 * Click on an object. Shift toggles membership; a plain click on an object
 * already in a multi-selection PRESERVES that selection, so the user can grab
 * a group and drag it without it collapsing to one object under the cursor.
 */
export function selectObject(id: ObjectId, shift: boolean): void {
  const { selection, setSelection, toggleSelection } = boardStore.getState()
  if (shift) {
    toggleSelection(id)
    return
  }
  if (selection.includes(id)) return
  setSelection([id])
}

export function beginMarquee(
  pointerId: number,
  px: number,
  py: number,
  shift: boolean,
): boolean {
  const { interaction, selection, setInteraction, clearSelection } = boardStore.getState()
  if (!canTransition(interaction.type, 'MARQUEEING')) return false

  // A plain drag on empty canvas starts a fresh selection. Shift keeps the
  // existing one so a marquee can extend it.
  if (!shift) clearSelection()

  setInteraction({
    type: 'MARQUEEING',
    startX: px,
    startY: py,
    currentX: px,
    currentY: py,
    pointerId,
    additive: shift ? [...selection] : [],
  })
  return true
}

export function updateMarquee(px: number, py: number): void {
  const { interaction, setInteraction } = boardStore.getState()
  if (interaction.type !== 'MARQUEEING') return
  setInteraction({ ...interaction, currentX: px, currentY: py })
}

/** The marquee rectangle, normalised so dragging any direction works. */
export function marqueeRect(s: {
  startX: number
  startY: number
  currentX: number
  currentY: number
}): Rect {
  return {
    x: Math.min(s.startX, s.currentX),
    y: Math.min(s.startY, s.currentY),
    width: Math.abs(s.currentX - s.startX),
    height: Math.abs(s.currentY - s.startY),
  }
}

/** Commit the marquee: select everything FULLY contained (FLOWS §8.2.3). */
export function endMarquee(element: Element | null): void {
  const { interaction, objects, setSelection, setInteraction } = boardStore.getState()
  if (interaction.type !== 'MARQUEEING') return

  releaseCapture(element, interaction.pointerId)

  const rect = marqueeRect(interaction)
  const inside = objectsInRect(objects.values(), rect)

  // Union with whatever Shift preserved, without duplicating.
  const merged = interaction.additive.length
    ? [...new Set([...interaction.additive, ...inside])]
    : inside

  setInteraction({ type: 'IDLE' })
  setSelection(merged)
}

export function cancelMarquee(element: Element | null): void {
  const { interaction, setInteraction } = boardStore.getState()
  if (interaction.type !== 'MARQUEEING') return
  releaseCapture(element, interaction.pointerId)
  // A cancelled marquee selects nothing and restores what Shift was extending.
  setSelection_(interaction.additive)
  setInteraction({ type: 'IDLE' })
}

const setSelection_ = (ids: readonly ObjectId[]) =>
  boardStore.getState().setSelection(ids)

/** R-CANVAS-053: every capturing state releases on exit, error paths included. */
export function releaseCapture(element: Element | null, pointerId: number): void {
  if (!element) return
  try {
    ;(element as HTMLElement).releasePointerCapture(pointerId)
  } catch {
    // Already released, or never captured. Not an error.
  }
}
