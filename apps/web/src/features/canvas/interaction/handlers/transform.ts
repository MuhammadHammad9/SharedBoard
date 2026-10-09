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
import { applyAndEmit, snapshotReader, updateOps } from '../../history/apply.js'
import { LABELS, nudgeKey } from '../../history/grouping.js'
import { releaseCapture } from './select.js'
import { emitTransform, emitTransformEnd } from '../../../presence/bus.js'

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
 *
 * These three are the only gestures that mutate the store BEFORE they commit:
 * the user has to see the objects move while dragging. So `applyAndEmit` is
 * handed `interaction.origin` — the pointerdown snapshot — as its
 * pre-mutation reader, which is what keeps R-UNDO-007 satisfied on a path
 * where the store itself has already forgotten where anything started.
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
  written = new Map()
  return { ids: objects.map(o => o.id), origin }
}

/*
 * ── Geometry only ────────────────────────────────────────────────────────────
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  A gesture owns the fields it changes, and nothing else.                 │
 * │                                                                          │
 * │  Remote ops keep arriving while the user drags. Writing whole objects   │
 * │  rebuilt from the pointerdown snapshot on every pointermove would put   │
 * │  back the colour, the text, the z-index a teammate changed a moment     │
 * │  ago — here and nowhere else, which is a divergence (R-CONV-002).       │
 * │                                                                          │
 * │  So each frame copies only these keys onto the CURRENT store object,    │
 * │  cancel restores only these keys, and the commit diffs only these keys. │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * `updatedAt` is deliberately not among them: it is stamped once, on the
 * commit op, so a cancelled gesture leaves the object exactly as every other
 * client has it.
 */
const GEOMETRY_KEYS = ['x', 'y', 'width', 'height', 'rotation', 'points'] as const

/** What this gesture last wrote, per object — to notice a remote write since. */
let written = new Map<ObjectId, BoardObject>()

/** `target` with `source`'s geometry keys. Every other field is `target`'s. */
function withGeometry(target: BoardObject, source: BoardObject): BoardObject {
  const out = { ...target } as unknown as Record<string, unknown>
  const from = source as unknown as Record<string, unknown>
  for (const key of GEOMETRY_KEYS) if (key in from) out[key] = from[key]
  return out as unknown as BoardObject
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * The origin for `id`, rebased onto any REMOTE geometry write since this
 * gesture last wrote it.
 *
 * A teammate moving the same object mid-drag is a later decision than our
 * pointerdown: their value becomes the base we transform from, the value a
 * cancel restores, and the "before" our undo returns to — rather than being
 * overwritten by the next frame and silently lost on this screen only.
 */
function rebasedOrigin(
  origin: Map<ObjectId, BoardObject>,
  id: ObjectId,
  current: BoardObject,
): BoardObject | undefined {
  const start = origin.get(id)
  if (!start) return undefined
  const last = (written.get(id) ?? start) as unknown as Record<string, unknown>
  const now = current as unknown as Record<string, unknown>
  let rebased: Record<string, unknown> | null = null
  for (const key of GEOMETRY_KEYS) {
    if (sameValue(now[key], last[key])) continue
    rebased ??= { ...(start as unknown as Record<string, unknown>) }
    rebased[key] = now[key]
  }
  if (!rebased) return start
  const next = rebased as unknown as BoardObject
  origin.set(id, next)
  return next
}

/**
 * One frame of a live gesture: transform each object from its (rebased)
 * origin and write only the geometry onto what the store holds now. ONE store
 * commit for the whole selection — E-07.
 */
function writeFrame(
  ids: readonly ObjectId[],
  origin: Map<ObjectId, BoardObject>,
  transform: (start: BoardObject) => BoardObject,
): void {
  const { objects, updateObjects } = boardStore.getState()
  const next: BoardObject[] = []
  for (const id of ids) {
    const current = objects.get(id)
    // Deleted by a teammate mid-gesture: delete wins (R-CONV-003).
    if (!current) continue
    const start = rebasedOrigin(origin, id, current)
    if (start) next.push(withGeometry(current, transform(start)))
  }
  updateObjects(next)
  // Read back what the store holds — it clamps on the way in.
  const after = boardStore.getState().objects
  for (const o of next) {
    const stored = after.get(o.id)
    if (stored) written.set(o.id, stored)
  }
}

/** Put the geometry back to the origin's, leaving every other field alone. */
function restoreGeometry(
  ids: readonly ObjectId[],
  origin: Map<ObjectId, BoardObject>,
): void {
  const { objects, updateObjects } = boardStore.getState()
  const next: BoardObject[] = []
  for (const id of ids) {
    const current = objects.get(id)
    if (!current) continue
    const start = rebasedOrigin(origin, id, current)
    if (start) next.push(withGeometry(current, start))
  }
  written = new Map()
  updateObjects(next)
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

  writeFrame(interaction.ids, interaction.origin, start => translateObject(start, dx, dy))

  // FLOWS E-07: presence, throttled to 20 Hz (10 Hz above 100 selected).
  // Ephemeral, never an op — the op is the one commit on pointerup.
  emitTransform(interaction.ids, dx, dy)
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

  // A press that never crossed the threshold moved nothing. Recording it would
  // put an entry on the stack whose undo is invisible.
  if (interaction.moved) {
    commitTransform(interaction.ids, interaction.origin, LABELS.move)
    emitTransformEnd()
  }
}

/**
 * Record a finished live gesture as ONE history entry — R-UNDO-004,
 * R-UNDO-010's "pushed on pointerup, never on pointermove".
 *
 * The forward ops are minimal UPDATEs diffed from the pointerdown snapshot
 * over the GEOMETRY keys only, so a drag records `{x, y, updatedAt}` and a
 * rotate records `{x, y, rotation, updatedAt}` — never the whole object, and
 * never a field a teammate changed mid-gesture, which would echo their edit
 * back as ours and let our undo revert it (R-UNDO-007, R-CONV-002).
 *
 * Re-applying those UPDATEs inside `applyAndEmit` writes values the store
 * already holds (plus the one `updatedAt` stamp). That is intentional: one
 * commit path, no second "record but do not apply" branch to keep in step with
 * it. `applyAndEmit` emits the whole batch as one op message (E-07).
 */
function commitTransform(
  ids: readonly ObjectId[],
  origin: Map<ObjectId, BoardObject>,
  label: string,
): void {
  const { objects } = boardStore.getState()
  const now = Date.now()
  const next: BoardObject[] = []
  for (const id of ids) {
    const current = objects.get(id)
    if (!current) continue
    const start = rebasedOrigin(origin, id, current)
    if (start) next.push({ ...withGeometry(start, current), updatedAt: now })
  }
  written = new Map()

  const before = snapshotReader(origin)
  applyAndEmit(updateOps(next, before), label, { before })
}

/** Restore every object to its pointerdown state — pointercancel, Escape. */
export function cancelDrag(element: Element | null): void {
  const { interaction, setInteraction } = boardStore.getState()
  if (interaction.type !== 'DRAGGING') return
  releaseCapture(element, interaction.pointerId)
  restoreGeometry(interaction.ids, interaction.origin)
  setInteraction({ type: 'IDLE' })
  if (interaction.moved) emitTransformEnd()
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
  const { interaction } = boardStore.getState()
  if (interaction.type !== 'RESIZING') return

  const box = resizeBox(interaction.startBox, interaction.handle, px, py, mods)
  writeFrame(interaction.ids, interaction.origin, start =>
    applyBoxTransform(start, interaction.startBox, box),
  )
}

export function endResize(element: Element | null): void {
  const { interaction, setInteraction } = boardStore.getState()
  if (interaction.type !== 'RESIZING') return
  releaseCapture(element, interaction.pointerId)
  setInteraction({ type: 'IDLE' })
  commitTransform(interaction.ids, interaction.origin, LABELS.resize)
}

export function cancelResize(element: Element | null): void {
  const { interaction, setInteraction } = boardStore.getState()
  if (interaction.type !== 'RESIZING') return
  releaseCapture(element, interaction.pointerId)
  restoreGeometry(interaction.ids, interaction.origin)
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

  writeFrame(interaction.ids, interaction.origin, start =>
    applyRotation(start, interaction.centreX, interaction.centreY, delta),
  )
  state.setInteraction({ ...interaction, currentDeg: ((delta % 360) + 360) % 360 })
}

export function endRotate(element: Element | null): void {
  const { interaction, setInteraction } = boardStore.getState()
  if (interaction.type !== 'ROTATING') return
  releaseCapture(element, interaction.pointerId)
  setInteraction({ type: 'IDLE' })
  commitTransform(interaction.ids, interaction.origin, LABELS.rotate)
}

export function cancelRotate(element: Element | null): void {
  const { interaction, setInteraction } = boardStore.getState()
  if (interaction.type !== 'ROTATING') return
  releaseCapture(element, interaction.pointerId)
  restoreGeometry(interaction.ids, interaction.origin)
  setInteraction({ type: 'IDLE' })
}

/* ── Keyboard nudge ───────────────────────────────────────────────────────── */

/**
 * FR-CANVAS-011: arrows nudge 1 canvas px, Shift+arrow 10.
 *
 * Unlike a drag, this does not mutate first — the store is still in its
 * pre-nudge state here, so `applyAndEmit` reads the previous values straight
 * out of it and applies the ops itself.
 *
 * Coalesced per burst: key repeat fires around thirty times a second, and
 * sixty history entries for a two-second press is not an undo stack anyone can
 * use. See grouping.ts for why this row is an extension of TRD §8.4 rather
 * than a transcription of it.
 */
export function nudgeSelection(dx: number, dy: number): void {
  const { selection } = boardStore.getState()
  if (selection.length === 0) return
  const next = selectedObjects().map(o => translateObject(o, dx, dy))
  applyAndEmit(updateOps(next), LABELS.nudge, { coalesceKey: nudgeKey(selection) })
}

/** Exported for the overlay's live readout and for tests. */
export function currentRotationDeg(): number | null {
  const { interaction } = boardStore.getState()
  return interaction.type === 'ROTATING' ? interaction.currentDeg : null
}

export type { Rect }
