import type { ObjectId } from '@coboard/shared'
import { boardStore, objectsInZOrder } from '../../../../stores/boardStore.js'
import { hitTest } from '../../geometry/hitTest.js'
import { canTransition } from '../machine.js'
import { releaseCapture } from './select.js'

/**
 * Object eraser — FR-CANVAS-006, FLOWS §14.2.
 *
 * Hovering highlights the object under the cursor in --color-danger;
 * pointer-down-and-drag deletes everything the pointer touches.
 *
 * The hover highlight is the one piece of motion permitted on this surface
 * (R-MOTION-003): it is feedback that prevents an irreversible mistake, and
 * PRD Persona B's stated fear is "clicking the wrong thing and deleting
 * someone else's work". A 120 ms colour fade earns its place; nothing else on
 * the canvas does.
 *
 * The pixel eraser that splits strokes is explicitly [P2] and out of scope.
 */

/** Objects deleted during the current drag, so each is removed exactly once. */
let erasedThisDrag: ObjectId[] = []

/** Update the hover highlight. No mutation — this runs on every pointermove. */
export function updateEraseHover(px: number, py: number): void {
  const { viewport, setEraseCandidate } = boardStore.getState()
  const hit = hitTest(px, py, objectsInZOrder(), viewport.zoom)
  setEraseCandidate(hit ? hit.id : null)
}

export function beginErase(pointerId: number, px: number, py: number): boolean {
  const { interaction, setInteraction } = boardStore.getState()
  if (!canTransition(interaction.type, 'ERASING')) return false

  erasedThisDrag = []
  setInteraction({ type: 'ERASING', pointerId })
  eraseAt(px, py)
  return true
}

/**
 * Delete whatever is under the pointer.
 *
 * Deletions accumulate across the drag and commit as ONE operation on
 * pointerup, rather than one per object. Sweeping across forty objects is a
 * single user action and must be a single undo (R-UNDO-004) and a single op
 * message (E-07) — forty separate deletes would need forty Ctrl+Zs.
 */
export function eraseAt(px: number, py: number): void {
  const { interaction, viewport, objects } = boardStore.getState()
  if (interaction.type !== 'ERASING') return

  // Skip what this drag already claimed, so a pointer lingering over one
  // object does not re-add it.
  const remaining = objectsInZOrder().filter(o => !erasedThisDrag.includes(o.id))
  const hit = hitTest(px, py, remaining, viewport.zoom)
  if (!hit || !objects.has(hit.id)) return

  erasedThisDrag.push(hit.id)
  // Removed from the store immediately so the user sees it vanish under the
  // cursor; the BATCH is what commits on pointerup.
  boardStore.getState().deleteObjects([hit.id])
}

export function endErase(element: Element | null): void {
  const { interaction, setInteraction, setEraseCandidate } = boardStore.getState()
  if (interaction.type !== 'ERASING') return
  releaseCapture(element, interaction.pointerId)
  setInteraction({ type: 'IDLE' })
  setEraseCandidate(null)

  // PHASE 6 SLOT: push ONE history entry holding an inverse CREATE for every
  // id in erasedThisDrag — the whole sweep is one undo.
  // PHASE 9 SLOT: emit one batched op:delete for the same set.
  erasedThisDrag = []
}

/** Ids erased during the current or most recent drag. For Phase 6 and tests. */
export const erasedIds = (): readonly ObjectId[] => erasedThisDrag

/** pointercancel — R-CANVAS-052. Erases already applied stand; the drag ends. */
export const cancelErase = endErase
