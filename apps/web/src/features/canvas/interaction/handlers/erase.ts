import type { BoardObject, ObjectId } from '@coboard/shared'
import { boardStore, objectsInZOrder } from '../../../../stores/boardStore.js'
import { hitTest } from '../../geometry/hitTest.js'
import {
  applyAndEmit,
  createOps,
  deleteOps,
  snapshotReader,
} from '../../history/apply.js'
import { LABELS } from '../../history/grouping.js'
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

/**
 * Objects deleted during the current drag, so each is removed exactly once.
 *
 * The whole OBJECT is kept, not just its id. The store has already forgotten
 * it by the time the sweep commits, and an inverse CREATE needs the full
 * object — position, colour, geometry, z-order — or undo restores a husk
 * (TRD §8.2).
 */
let erasedThisDrag: BoardObject[] = []

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
  const claimed = new Set(erasedThisDrag.map(o => o.id))
  const remaining = objectsInZOrder().filter(o => !claimed.has(o.id))
  const hit = hitTest(px, py, remaining, viewport.zoom)

  const object = hit ? objects.get(hit.id) : undefined
  if (!object) return

  // Snapshotted BEFORE the removal — R-UNDO-007. One statement later it is
  // gone and the inverse CREATE could not be built at all.
  erasedThisDrag.push(object)
  // Removed from the store immediately so the user sees it vanish under the
  // cursor; the BATCH is what commits on pointerup.
  boardStore.getState().deleteObjects([object.id])
}

export function endErase(element: Element | null): void {
  const { interaction, setInteraction, setEraseCandidate } = boardStore.getState()
  if (interaction.type !== 'ERASING') return
  releaseCapture(element, interaction.pointerId)
  setInteraction({ type: 'IDLE' })
  setEraseCandidate(null)

  const erased = erasedThisDrag
  erasedThisDrag = []
  if (erased.length === 0) return

  /*
   * ONE history entry for the whole sweep — R-UNDO-004. Sweeping across forty
   * objects is one user action and must be one Ctrl+Z.
   *
   * The objects are already out of the store, so the pre-state reader is the
   * snapshot taken in `eraseAt` rather than the live document. The DELETE ops
   * re-applied inside applyAndEmit are no-ops on objects that have already
   * gone, which is what lets the eraser share the single commit path instead
   * of needing a record-only variant of it.
   */
  const snapshot = new Map(erased.map(o => [o.id, o]))
  // One call: one undo entry, and one batched op message (E-07).
  applyAndEmit(deleteOps(erased.map(o => o.id)), LABELS.erase, {
    before: snapshotReader(snapshot),
  })
}

/** Ids erased during the current or most recent drag. For tests. */
export const erasedIds = (): readonly ObjectId[] => erasedThisDrag.map(o => o.id)

/**
 * Abandon the sweep — Escape (R-CANVAS-055) and a live demotion to viewer
 * (FLOWS §9.5). Nothing was emitted yet, so nothing is committed: the objects
 * the drag removed go back exactly as they were, through the raw store path
 * (no history, no op). One a teammate deleted meanwhile stays deleted —
 * delete wins (R-CONV-003).
 *
 * pointercancel does NOT come here: the OS stealing the pointer is not the
 * user changing their mind, so usePointer commits that sweep with `endErase`.
 */
export function cancelErase(element: Element | null): void {
  const { interaction, setInteraction, setEraseCandidate } = boardStore.getState()
  if (interaction.type !== 'ERASING') return
  releaseCapture(element, interaction.pointerId)
  setInteraction({ type: 'IDLE' })
  setEraseCandidate(null)

  const erased = erasedThisDrag
  erasedThisDrag = []
  const { objects, tombstones, applyOps } = boardStore.getState()
  const restore = erased.filter(o => !objects.has(o.id) && !tombstones.has(o.id))
  if (restore.length > 0) applyOps(createOps(restore))
}
