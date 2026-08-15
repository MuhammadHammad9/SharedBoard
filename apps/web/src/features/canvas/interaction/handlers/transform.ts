import type { BoardObject, ObjectId, Rect } from '@coboard/shared'
import { boardStore, selectedObjects } from '../../../../stores/boardStore.js'
import {
  applyBoxTransform,
  applyRotation,
  resizeBox,
  rotationFor,
  translateObject,
} from '../../geometry/transformSelection.js'
import { selectionBounds, type HandleId } from '../../geometry/bounds.js'
import { canTransition } from '../machine.js'
import { releaseCapture } from './select.js'

/**
 * Move, resize and rotate — FR-CANVAS-011/012/013, FLOWS §8.2.3.
 *
 * One shared shape across all three:
 *
 *   begin  — snapshot every selected object exactly as it is now
 *   update — recompute from the SNAPSHOT and the current pointer, never from
 *            the previous frame
 *   end    — release capture, return to IDLE
 *
 * Recomputing from the snapshot rather than accumulating deltas is what keeps
 * a thirty-second drag from drifting: floating-point error is reapplied to the
 * same origin each frame instead of compounding, and releasing Shift mid-drag
 * cleanly undoes the constraint rather than baking it in.
 *
 * Every commit goes through `updateObjects`, one call for the whole selection
 * — E-07's "batch into one op message", R-UNDO-004's "one history entry".
 */

/** Pointer travel, in canvas units, before a press counts as a drag. */
const DRAG_THRESHOLD = 2

/** Snapshot the selection so updates can always recompute from the origin. */
function snapshot(): { ids: ObjectId[]; origin: Map<ObjectId, BoardObject> } {
  const objects = selectedObjects()
  const origin = new Map<ObjectId, BoardObject>()
  for (const o of objects) origin.set(o.id, o)
  return { ids: objects.map(o => o.id), origin }
}

/* ── Move ─────────────────────────────────────────────────────────────────── */

export function beginDrag(pointerId: number, px: number, py: number): boolean {
  const { interaction, setInteraction } = boardStore.getState()
  if (!canTransition(interaction.type, 'DRAGGING')) return false

  const { ids, origin } = snapshot()
  if (ids.length === 0) return false

  setInteraction({
    type: 'DRAGGING',
    pointerId,
    ids,
    startX: px,
    startY: py,
    origin,
    moved: false,
  })
  return true
}

export function updateDrag(px: number, py: number): void {
  const state = boardStore.getState()
  const { interaction } = state
  if (interaction.type !== 'DRAGGING') return

  const dx = px - interaction.startX
  const dy = py - interaction.startY

  // A press that never really moved must not be recorded as a drag — it is a
  // click, and committing a zero-delta update would create a pointless op and
  // (from Phase 6) a pointless undo entry.
  if (
    !interaction.moved &&
    Math.abs(dx) < DRAG_THRESHOLD &&
    Math.abs(dy) < DRAG_THRESHOLD
  )
    return
  if (!interaction.moved) state.setInteraction({ ...interaction, moved: true })

  const next: BoardObject[] = []
  for (const id of interaction.ids) {
    const start = interaction.origin.get(id)
    if (start) next.push(translateObject(start, dx, dy))
  }
  state.updateObjects(next)

  // PHASE 10 SLOT: throttled presence:transform at 20 Hz, dropping to 10 Hz
  // above 100 selected objects (FLOWS E-07). Ephemeral, never an op.
}

export function endDrag(element: Element | null): void {
  const { interaction, setInteraction } = boardStore.getState()
  if (interaction.type !== 'DRAGGING') return
  releaseCapture(element, interaction.pointerId)
  setInteraction({ type: 'IDLE' })

  // PHASE 6 SLOT: if interaction.moved, push ONE history entry holding an
  // inverse UPDATE per object, built from interaction.origin.
  // PHASE 9 SLOT: emit one batched op:update message.
}

/** Restore every object to its pointerdown state — pointercancel, Escape. */
export function cancelDrag(element: Element | null): void {
  const { interaction, updateObjects, setInteraction } = boardStore.getState()
  if (interaction.type !== 'DRAGGING') return
  releaseCapture(element, interaction.pointerId)
  updateObjects([...interaction.origin.values()])
  setInteraction({ type: 'IDLE' })
}

/* ── Resize ───────────────────────────────────────────────────────────────── */

export function beginResize(pointerId: number, handle: HandleId): boolean {
  const { interaction, setInteraction } = boardStore.getState()
  if (!canTransition(interaction.type, 'RESIZING')) return false

  const { ids, origin } = snapshot()
  const startBox = selectionBounds([...origin.values()])
  if (ids.length === 0 || !startBox) return false

  setInteraction({ type: 'RESIZING', pointerId, handle, ids, startBox, origin })
  return true
}

export function updateResize(
  px: number,
  py: number,
  mods: { aspect: boolean; fromCentre: boolean },
): void {
  const { interaction, updateObjects } = boardStore.getState()
  if (interaction.type !== 'RESIZING') return

  const box = resizeBox(interaction.startBox, interaction.handle, px, py, mods)

  const next: BoardObject[] = []
  for (const id of interaction.ids) {
    const start = interaction.origin.get(id)
    if (start) next.push(applyBoxTransform(start, interaction.startBox, box))
  }
  updateObjects(next)
}

export function endResize(element: Element | null): void {
  const { interaction, setInteraction } = boardStore.getState()
  if (interaction.type !== 'RESIZING') return
  releaseCapture(element, interaction.pointerId)
  setInteraction({ type: 'IDLE' })
  // PHASE 6 SLOT: one history entry, pushed here on pointerup (R-UNDO-010).
}

export function cancelResize(element: Element | null): void {
  const { interaction, updateObjects, setInteraction } = boardStore.getState()
  if (interaction.type !== 'RESIZING') return
  releaseCapture(element, interaction.pointerId)
  updateObjects([...interaction.origin.values()])
  setInteraction({ type: 'IDLE' })
}

/* ── Rotate ───────────────────────────────────────────────────────────────── */

export function beginRotate(pointerId: number, px: number, py: number): boolean {
  const { interaction, setInteraction } = boardStore.getState()
  if (!canTransition(interaction.type, 'ROTATING')) return false

  const { ids, origin } = snapshot()
  const box = selectionBounds([...origin.values()])
  if (ids.length === 0 || !box) return false

  const centreX = box.x + box.width / 2
  const centreY = box.y + box.height / 2

  setInteraction({
    type: 'ROTATING',
    pointerId,
    ids,
    centreX,
    centreY,
    // Captured so rotation is applied as a DELTA. Without it the selection
    // snaps to face the cursor the instant the handle is grabbed.
    startAngle: rotationFor(centreX, centreY, px, py, false),
    origin,
    currentDeg: 0,
  })
  return true
}

export function updateRotate(px: number, py: number, snap: boolean): void {
  const state = boardStore.getState()
  const { interaction } = state
  if (interaction.type !== 'ROTATING') return

  const angle = rotationFor(interaction.centreX, interaction.centreY, px, py, snap)
  let delta = angle - interaction.startAngle
  // Snapping applies to the RESULT, not the delta, so a snapped rotation lands
  // on a true multiple of 15° regardless of where the drag started.
  if (snap) delta = Math.round(delta / 15) * 15

  const next: BoardObject[] = []
  for (const id of interaction.ids) {
    const start = interaction.origin.get(id)
    if (start)
      next.push(applyRotation(start, interaction.centreX, interaction.centreY, delta))
  }
  state.updateObjects(next)
  state.setInteraction({ ...interaction, currentDeg: ((delta % 360) + 360) % 360 })
}

export function endRotate(element: Element | null): void {
  const { interaction, setInteraction } = boardStore.getState()
  if (interaction.type !== 'ROTATING') return
  releaseCapture(element, interaction.pointerId)
  setInteraction({ type: 'IDLE' })
}

export function cancelRotate(element: Element | null): void {
  const { interaction, updateObjects, setInteraction } = boardStore.getState()
  if (interaction.type !== 'ROTATING') return
  releaseCapture(element, interaction.pointerId)
  updateObjects([...interaction.origin.values()])
  setInteraction({ type: 'IDLE' })
}

/* ── Keyboard nudge ───────────────────────────────────────────────────────── */

/** FR-CANVAS-011: arrows nudge 1 canvas px, Shift+arrow 10. */
export function nudgeSelection(dx: number, dy: number): void {
  const { selection, updateObjects } = boardStore.getState()
  if (selection.length === 0) return
  updateObjects(selectedObjects().map(o => translateObject(o, dx, dy)))
  // PHASE 6 SLOT: one entry per burst, coalescing within 1 s (R-UNDO-010).
}

/** Exported for the overlay's live readout and for tests. */
export function currentRotationDeg(): number | null {
  const { interaction } = boardStore.getState()
  return interaction.type === 'ROTATING' ? interaction.currentDeg : null
}

export type { Rect }
