import {
  STICKY_TEXT_MAX,
  TEXT_MAX,
  type BoardObject,
  type ObjectId,
  type StickyObject,
  type TextObject,
} from '@coboard/shared'
import { boardStore } from '../../../../stores/boardStore.js'

/**
 * Text editing — FR-CANVAS-008, FR-CANVAS-009, FLOWS §8.2.2.
 *
 * The editor itself is a DOM textarea (see TextOverlay.tsx). This module owns
 * the state transitions around it: what happens on every keystroke, and what
 * happens on each of the three exits.
 */

/** FLOWS §8.2.2 step 3: "debounced 300 ms: emit an update with the new text". */
export const TEXT_DEBOUNCE_MS = 300

const isEditable = (o: BoardObject): o is StickyObject | TextObject =>
  o.type === 'sticky' || o.type === 'text'

/** Per-type ceiling. Enforced here as well as in Zod — reject, never truncate silently. */
const maxLengthFor = (o: BoardObject): number =>
  o.type === 'sticky' ? STICKY_TEXT_MAX : TEXT_MAX

/**
 * Apply typed text to the object being edited.
 *
 * Written straight through, not debounced: the canvas renders the text live
 * beneath the transparent overlay (FLOWS §8.2.2 step 3), so any delay here
 * would show as the canvas text lagging the caret. The 300 ms debounce belongs
 * on the *network* emit, which is Phase 9's job and is marked below.
 */
export function updateEditingText(text: string): void {
  const { editingTextId, objects, updateObjects } = boardStore.getState()
  if (!editingTextId) return

  const object = objects.get(editingTextId)
  if (!object || !isEditable(object)) return

  const clipped = text.slice(0, maxLengthFor(object))
  if (clipped === object.text) return

  updateObjects([{ ...object, text: clipped, updatedAt: Date.now() }])

  // PHASE 9 SLOT: debounced TEXT_DEBOUNCE_MS, emit op:update with the new
  // text so remote users see it appear as it is typed.
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
  const { editingTextId, editingJustCreated, objects } = state
  if (!editingTextId) return false

  const object = objects.get(editingTextId)
  state.endTextEdit()

  if (!object || !isEditable(object)) return false

  if (object.text.trim() === '' && editingJustCreated) {
    state.deleteObjects([editingTextId])
    return true
  }

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
