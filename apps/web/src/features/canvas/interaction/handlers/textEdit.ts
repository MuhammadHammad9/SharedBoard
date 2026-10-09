import {
  STICKY_TEXT_MAX,
  TEXT_MAX,
  TEXT_UPDATE_DEBOUNCE_MS,
  type BoardObject,
  type ObjectId,
  type StickyObject,
  type TextObject,
} from '@coboard/shared'
import { boardStore } from '../../../../stores/boardStore.js'
import {
  applyAndEmit,
  createOps,
  snapshotReader,
  updateOps,
} from '../../history/apply.js'
import { LABELS, typingKey } from '../../history/grouping.js'

/**
 * Text editing — FR-CANVAS-008, FR-CANVAS-009, FLOWS §8.2.2.
 *
 * The editor itself is a DOM textarea (see TextOverlay.tsx). This module owns
 * the state transitions around it: what happens on every keystroke, and what
 * happens on each of the three exits.
 */

/** FLOWS §8.2.2 step 3: "debounced 300 ms: emit an update with the new text". */
export const TEXT_DEBOUNCE_MS = TEXT_UPDATE_DEBOUNCE_MS

/**
 * The typing burst not yet emitted: the object as it was BEFORE the burst's
 * first keystroke (the undo target, R-UNDO-007) and the debounce timer.
 */
let burst: { base: BoardObject; timer: ReturnType<typeof setTimeout> } | null = null

/**
 * Emit the pending typing burst now, as ONE op and one (coalescing) history
 * entry. Idempotent, and safe with nothing pending.
 *
 * Called by the debounce timer and by every exit — commit, Escape, click
 * outside, the overlay unmounting, the board being left — so no keystroke is
 * ever held back past the moment the editor goes away.
 */
export function flushPendingText(): void {
  if (!burst) return
  const { base, timer } = burst
  burst = null
  clearTimeout(timer)
  const current = boardStore.getState().objects.get(base.id)
  // Deleted under us meanwhile: delete wins (R-CONV-003), nothing to send.
  if (!current || !isEditable(current)) return
  const before = snapshotReader(new Map([[base.id, base]]))
  // Only the fields typing changes — never a field a teammate wrote meanwhile.
  const next = {
    ...base,
    text: current.text,
    updatedAt: current.updatedAt,
  } as BoardObject
  applyAndEmit(updateOps([next], before), LABELS.typing, {
    before,
    coalesceKey: typingKey(base.id),
  })
}

const isEditable = (o: BoardObject): o is StickyObject | TextObject =>
  o.type === 'sticky' || o.type === 'text'

/** Per-type ceiling. Enforced here as well as in Zod — reject, never truncate silently. */
const maxLengthFor = (o: BoardObject): number =>
  o.type === 'sticky' ? STICKY_TEXT_MAX : TEXT_MAX

/**
 * Apply typed text to the object being edited.
 *
 * The STORE write is immediate: the canvas renders the text live beneath the
 * transparent overlay (FLOWS §8.2.2 step 3), so any delay here would show as
 * the canvas text lagging the caret. The NETWORK emit is debounced to
 * TEXT_UPDATE_DEBOUNCE_MS — one op per pause, not a full-text op per key —
 * and teammates see the text arrive in those steps as it is typed.
 */
export function updateEditingText(text: string): void {
  const { editingTextId, editingJustCreated, objects, updateObjects } =
    boardStore.getState()
  if (!editingTextId) return

  const object = objects.get(editingTextId)
  if (!object || !isEditable(object)) return

  const clipped = text.slice(0, maxLengthFor(object))
  if (clipped === object.text) return

  const next = { ...object, text: clipped, updatedAt: Date.now() }

  /*
   * UNDO, TRD §8.4's typing row: "1 per burst — coalesce updates that occur
   * within 1 s of each other on the same object".
   *
   * A note still being created records nothing yet. Its whole existence,
   * text included, becomes one CREATE entry when the editor closes — see
   * placeAndEdit. Recording keystrokes onto an object that has no CREATE
   * behind it would leave undo able to empty a note it cannot then remove.
   */
  if (editingJustCreated) {
    updateObjects([next])
    return
  }

  // A burst on another object (should one still be pending) goes out first.
  if (burst && burst.base.id !== editingTextId) flushPendingText()
  if (boardStore.getState().readOnly) return

  if (burst) clearTimeout(burst.timer)
  const base = burst?.base ?? object
  burst = { base, timer: setTimeout(flushPendingText, TEXT_UPDATE_DEBOUNCE_MS) }
  updateObjects([next])
}

/**
 * Finish editing — FLOWS §8.2.2 step 4, all three exits (Escape, click
 * outside, Tab).
 *
 * The empty-discard rule is the subtle part. An object that is still empty is
 * deleted ONLY if it was created in this interaction. Clearing an existing
 * note and clicking away is a deliberate edit; destroying the object would
 * lose its position, colour and z-order along with the text
 * (FR-CANVAS-009, anti-pattern A-24).
 *
 * Returns true when the object was discarded.
 */
export function commitTextEdit(): boolean {
  const state = boardStore.getState()
  const { editingTextId, editingJustCreated } = state
  if (!editingTextId) return false

  // Whatever was typed since the last pause is sent before the editor closes.
  flushPendingText()
  const object = boardStore.getState().objects.get(editingTextId)
  state.endTextEdit()

  if (!object || !isEditable(object)) return false

  if (object.text.trim() === '' && editingJustCreated) {
    // Nothing was ever recorded for a just-created note, so this leaves the
    // undo stack exactly as it found it — which is right: placing a note and
    // immediately abandoning it is not an action to undo.
    state.deleteObjects([editingTextId])
    return true
  }

  /*
   * The one entry a click-placed sticky or text object produces — ONE CREATE
   * carrying the finished text, pushed once the user has committed to keeping
   * it. See placeAndEdit for why the create is deferred to here.
   */
  if (editingJustCreated) applyAndEmit(createOps([object]), LABELS.create)

  // Left selected, so the properties panel stays on the thing just edited.
  state.setSelection([editingTextId])
  return false
}

/**
 * Begin editing an existing object — double-click on a sticky or text object.
 * `justCreated` is false: this object already has a life of its own.
 */
export function editExisting(id: ObjectId): boolean {
  const state = boardStore.getState()
  const object = state.objects.get(id)
  if (!object || !isEditable(object)) return false
  if (state.interaction.type !== 'IDLE') return false

  state.beginTextEdit(id, false)
  return true
}

/** The object currently under the editor, or null. */
export function editingObject(): StickyObject | TextObject | null {
  const { editingTextId, objects } = boardStore.getState()
  if (!editingTextId) return null
  const object = objects.get(editingTextId)
  return object && isEditable(object) ? object : null
}
