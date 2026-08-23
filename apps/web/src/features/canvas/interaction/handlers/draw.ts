import {
  STROKE_POINTS_MAX,
  STROKE_POINT_STRIDE,
  clampCoord,
  screenPoint,
  screenToCanvas,
  simplifyStroke,
  strokeBounds,
  type ObjectId,
  type StrokeObject,
} from '@coboard/shared'
import { emitStrokeDone, emitStrokeProgress } from '../../../presence/bus.js'
import { boardStore, nextZIndex } from '../../../../stores/boardStore.js'
import { applyAndEmit, createOps } from '../../history/apply.js'
import { LABELS } from '../../history/grouping.js'
import { canTransition } from '../machine.js'

/**
 * Freehand drawing — FR-CANVAS-005, FLOWS §8.2.1.
 *
 * The four-step sequence this file implements:
 *
 *   pointerdown → mint an op id, seed a draft on the INTERACTION layer
 *   pointermove → append canvas-space points; mark layer 2 dirty only
 *   pointerup   → simplify ONCE, commit to the object layer
 *   Escape /
 *   pointercancel → discard entirely, commit nothing
 *
 * The commit goes through `applyAndEmit`, which is where the undo entry is
 * recorded and where Phase 9 will emit the op and fill the outbox. Phase 10
 * adds the throttled presence broadcast inside `appendPoint`.
 */

/** Local author id until accounts exist in Phase 7. */
const LOCAL_AUTHOR = 'local'

/**
 * Mouse hardware has no pressure sensor and reports 0.5 while a button is
 * down, or a flat 0 in some browsers. A real stylus reports its own value.
 * Normalising a zero to the mouse default keeps the stored data meaningful
 * either way — see the pressure note in renderer/shapes/stroke.ts for why it
 * is captured but not rendered as width.
 */
const DEFAULT_PRESSURE = 0.5
const pressureOf = (raw: number): number =>
  !Number.isFinite(raw) || raw <= 0 ? DEFAULT_PRESSURE : raw > 1 ? 1 : raw

/** Screen → canvas, clamped. R-COORD-004: the conversion exists in one place. */
function toCanvas(screenX: number, screenY: number): { x: number; y: number } {
  const { viewport } = boardStore.getState()
  const p = screenToCanvas(screenPoint(screenX, screenY), viewport)
  // R-COORD-003 / FLOWS E-04: clamp on creation. The renderer must never see
  // an out-of-range value, and a hostile zoom can put one there.
  return { x: clampCoord(p.x), y: clampCoord(p.y) }
}

/**
 * Begin a stroke. Returns false when the machine refuses the transition, in
 * which case the caller must not capture the pointer.
 */
export function beginDraw(
  pointerId: number,
  screenX: number,
  screenY: number,
  pressure: number,
): boolean {
  const { interaction, pen, setInteraction, startDraft } = boardStore.getState()
  if (!canTransition(interaction.type, 'DRAWING')) return false

  // R-SYNC-014: the op id is minted client-side and is the idempotency key for
  // the whole life of this object. Same value as the object id, so a replayed
  // create cannot produce a duplicate.
  const id = crypto.randomUUID()
  const p = toCanvas(screenX, screenY)

  startDraft({
    id,
    points: [p.x, p.y, pressureOf(pressure)],
    color: pen.color,
    strokeWidth: pen.strokeWidth,
    opacity: pen.opacity,
  })
  setInteraction({ type: 'DRAWING', pointerId, opId: id })
  return true
}

/**
 * Append a sample. Called once per pointermove, or once per coalesced event on
 * high-refresh hardware.
 *
 * R-CANVAS-011: this mutates and marks dirty. It does NOT draw — the rAF loop
 * does, exactly once per frame no matter how many samples arrived.
 * R-CANVAS-032: no simplification here. Simplifying a growing array on every
 * move is O(n²) work whose result is discarded on the next move.
 */
export function appendPoint(screenX: number, screenY: number, pressure: number): void {
  const { interaction, draft, touchDraft } = boardStore.getState()
  if (interaction.type !== 'DRAWING' || !draft) return

  // A stroke long enough to hit the schema ceiling stops growing rather than
  // failing validation at commit and losing the whole thing.
  if (draft.points.length >= STROKE_POINTS_MAX) return

  const p = toCanvas(screenX, screenY)
  draft.points.push(p.x, p.y, pressureOf(pressure))
  touchDraft()

  /*
   * Broadcast the stroke as PRESENCE — FR-RT-006, R-SYNC-005.
   *
   * Not an op. It is never persisted, never sequenced, never acked and
   * dropped entirely when offline: what everyone else sees is a preview,
   * replaced by the real object when `commitDraw` emits the CREATE.
   *
   * The full array goes in; the emitter slices the delta since its last send
   * (R-SYNC-041). Sending it whole 20 times a second would be roughly
   * 100 KB/s per user on a long stroke.
   */
  emitStrokeProgress(draft.id, draft.points)
}

/**
 * Commit on pointerup. Returns the created object, or null when the gesture
 * produced nothing worth storing.
 */
export function commitDraw(element: Element | null): StrokeObject | null {
  const { interaction, draft, clearDraft, setInteraction } = boardStore.getState()
  if (interaction.type !== 'DRAWING') return null

  releaseCapture(element, interaction.pointerId)
  setInteraction({ type: 'IDLE' })
  clearDraft()

  // Clear everyone else's preview. The CREATE op below replaces it; leaving
  // the preview up would double-draw the stroke for a frame.
  if (draft) emitStrokeDone(draft.id)

  if (!draft) return null

  // R-CANVAS-032 (Blocking): Ramer–Douglas–Peucker, ONCE, here.
  const points = simplifyStroke(draft.points)

  // A click rather than a drag. Storing a one-point stroke would put an object
  // on the board that renders as nothing and can never be selected.
  if (points.length < STROKE_POINT_STRIDE * 2) return null

  const box = strokeBounds(points, draft.strokeWidth)
  const now = Date.now()
  const object: StrokeObject = {
    id: draft.id as ObjectId,
    type: 'stroke',
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    rotation: 0,
    zIndex: nextZIndex(),
    opacity: draft.opacity,
    createdBy: LOCAL_AUTHOR,
    // R-CONV-010: display only. Ordering is the server's sequence number.
    createdAt: now,
    updatedAt: now,
    points,
    color: draft.color,
    strokeWidth: draft.strokeWidth,
    simplified: true,
  }

  // ONE history entry, { forward:[CREATE], inverse:[DELETE] } — TRD §8.4's
  // "one stroke = 1". Phase 9 emits the same op from inside applyAndEmit.
  applyAndEmit(createOps([object]), LABELS.draw)
  return object
}

/**
 * Discard the stroke — FLOWS E-09 (Escape) and R-CANVAS-052 (pointercancel,
 * fired when the OS steals the pointer for a system gesture). Both are handled
 * identically and neither is ever ignored: forgetting pointercancel leaves the
 * app stuck in DRAWING forever.
 */
export function cancelDraw(element: Element | null): void {
  const { interaction, clearDraft, setInteraction } = boardStore.getState()
  if (interaction.type !== 'DRAWING') return

  releaseCapture(element, interaction.pointerId)
  const draftId = boardStore.getState().draft?.id
  clearDraft()
  setInteraction({ type: 'IDLE' })

  /*
   * Nothing is committed, but the `done` still goes out: everyone else has a
   * half-drawn preview on their overlay, and abandoning it leaves a stroke on
   * their screen that no object will ever replace.
   */
  if (draftId) emitStrokeDone(draftId)
}

/** R-CANVAS-053: every capturing state releases on exit, error paths included. */
function releaseCapture(element: Element | null, pointerId: number): void {
  if (!element) return
  try {
    ;(element as HTMLElement).releasePointerCapture(pointerId)
  } catch {
    // Already released, or never captured. Not an error.
  }
}
