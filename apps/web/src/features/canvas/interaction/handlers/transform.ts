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
import { findSnaps, type Guide } from '../../geometry/alignmentGuides.js'
import { getViewRect, isVisible } from '../../geometry/culling.js'
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

/**
 * Above this many selected objects, alignment guides are not computed.
 *
 * See the note at the call site: it is a behaviour decision that happens to
 * also be the difference between 45 and 60 fps on the 500-object stress drag.
 */
const SNAP_MAX_SELECTION = 50

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
    guides: [],
  })
  return true
}

export function updateDrag(px: number, py: number, snapEnabled = true): void {
  const state = boardStore.getState()
  const { interaction } = state
  if (interaction.type !== 'DRAGGING') return

  let dx = px - interaction.startX
  let dy = py - interaction.startY

  // A press that never really moved must not be recorded as a drag — it is a
  // click, and committing a zero-delta update would create a pointless op and
  // (from Phase 6) a pointless undo entry.
  if (
    !interaction.moved &&
    Math.abs(dx) < DRAG_THRESHOLD &&
    Math.abs(dy) < DRAG_THRESHOLD
  ) {
    return
  }

  /*
   * Alignment guides — FR-CANVAS-020.
   *
   * The snap is computed from the ORIGIN box plus the raw delta, never from
   * the already-snapped position. Feeding a snapped box back in on the next
   * frame would let the guide capture the drag and refuse to let go.
   *
   * Candidates are non-selected objects inside the viewport: an object cannot
   * align to itself, and one nobody can see is not a landmark anyone is
   * aiming at. Ctrl disables the whole thing, which is how the user places
   * something deliberately close to but not aligned with a neighbour.
   */
  let guides: Guide[] = []
  const originBox = selectionBounds([...interaction.origin.values()])

  /*
   * Guides are skipped for large selections, and the reason is behavioural
   * before it is a performance one: aligning the union box of two hundred
   * objects to one neighbour's edge is not something anyone is trying to do.
   * FR-CANVAS-020 describes placing an object next to another object.
   *
   * It also removes the search from the E-07 stress path, where it was the
   * difference between 45 and 60 fps on a 500-object drag — the scan is O(all
   * objects) per frame, on top of the culling pass the renderer already does.
   */
  const worthSnapping = interaction.ids.length <= SNAP_MAX_SELECTION

  if (snapEnabled && worthSnapping && originBox) {
    const { width, height } = viewSize()
    const view = getViewRect(state.viewport, width, height)
    const selected = new Set(interaction.ids)

    const others: BoardObject[] = []
    for (const o of state.objects.values()) {
      if (!selected.has(o.id) && isVisible(o, view)) others.push(o)
    }

    const snap = findSnaps(
      { ...originBox, x: originBox.x + dx, y: originBox.y + dy },
      others,
      state.viewport.zoom,
      true,
    )
    dx += snap.dx
    dy += snap.dy
    guides = snap.guides
  }

  // Write the interaction back only when something the renderer cares about
  // actually changed — `moved`, or the guide set. A fresh object every
  // pointermove would dirty layer 3 sixty times a second for nothing.
  const guidesChanged = guides.length !== interaction.guides.length || guides.length > 0
  if (!interaction.moved || guidesChanged) {
    state.setInteraction({ ...interaction, moved: true, guides })
  }

  const next: BoardObject[] = []
  for (const id of interaction.ids) {
    const start = interaction.origin.get(id)
    if (start) next.push(translateObject(start, dx, dy))
  }
  state.updateObjects(next)

  // PHASE 10 SLOT: throttled presence:transform at 20 Hz, dropping to 10 Hz
  // above 100 selected objects (FLOWS E-07). Ephemeral, never an op.
}

/**
 * Viewport pixel size, injected by the Canvas at mount.
 *
 * The guide search needs it to cull to the visible set, and this module has no
 * DOM of its own. An explicit injection point beats a hidden global.
 */
let viewSizeSource: () => { width: number; height: number } = () => ({
  width: 0,
  height: 0,
})
export const setViewSizeSource = (fn: () => { width: number; height: number }): void => {
  viewSizeSource = fn
}
const viewSize = () => viewSizeSource()

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
