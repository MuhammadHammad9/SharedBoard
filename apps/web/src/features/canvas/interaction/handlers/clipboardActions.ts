import {
  clampCoord,
  type BoardObject,
  type ObjectId,
  type TextObject,
} from '@coboard/shared'
import { boardStore, nextZIndex, selectedObjects } from '../../../../stores/boardStore.js'
import {
  DUPLICATE_OFFSET,
  deserialize,
  readSystemClipboard,
  rekey,
  serialize,
  writeSystemClipboard,
} from '../../../../lib/clipboard.js'
import { applyAndEmit, createOps, deleteOps, updateOps } from '../../history/apply.js'
import { LABELS } from '../../history/grouping.js'
import { buildObject } from './create.js'

/**
 * Copy, cut, paste and duplicate against the store — FR-CANVAS-015, FLOWS E-06.
 *
 * Each writes to BOTH the system clipboard (for cross-tab) and the in-memory
 * fallback (for when the system one is denied), so a paste has two chances to
 * find something.
 */

export function copySelection(): BoardObject[] {
  const objects = selectedObjects()
  if (objects.length === 0) return []
  boardStore.getState().setClipboard(objects)
  void writeSystemClipboard(serialize(objects))
  return objects
}

export function cutSelection(): BoardObject[] {
  const objects = copySelection()
  if (objects.length === 0) return []
  // One entry for the whole cut, whatever its size — R-UNDO-004.
  applyAndEmit(deleteOps(objects.map(o => o.id)), LABELS.cut)
  return objects
}

/**
 * Paste at the pointer — FR-CANVAS-015, "paste places objects at the pointer
 * position".
 *
 * The whole pasted group is translated so its top-left lands at the pointer,
 * which preserves the objects' relative arrangement. Offsetting each object
 * individually to the pointer would collapse a diagram into a pile.
 */
export async function pasteAt(canvasX: number, canvasY: number): Promise<BoardObject[]> {
  const state = boardStore.getState()

  const raw = await readSystemClipboard()
  let objects = raw ? deserialize(raw) : []

  // FLOWS E-06: plain text that is not a CoBoard payload becomes a text
  // object at the pointer. Anything else is ignored silently.
  if (objects.length === 0 && raw && raw.trim() !== '') {
    const created = buildObject(
      'text',
      { x: canvasX, y: canvasY, width: 240, height: state.text.fontSize * 1.35 },
      crypto.randomUUID() as ObjectId,
    )
    if (created) {
      const withText = { ...created, text: raw.slice(0, 5_000) } as TextObject
      applyAndEmit(createOps([withText]), LABELS.paste)
      state.setSelection([withText.id])
      return [withText]
    }
  }

  // Fall back to the in-memory clipboard when the system read was denied or
  // held nothing of ours.
  if (objects.length === 0) objects = state.clipboard
  if (objects.length === 0) return []

  let minX = Infinity
  let minY = Infinity
  for (const o of objects) {
    if (o.x < minX) minX = o.x
    if (o.y < minY) minY = o.y
  }

  const pasted = rekey(objects, canvasX - minX, canvasY - minY, nextZIndex)
  // TRD §8.4: "paste 5 objects → 1 entry". One call, one entry, whatever N is.
  applyAndEmit(createOps(pasted), LABELS.paste)
  state.setSelection(pasted.map(o => o.id))
  return pasted
}

/** Duplicate in place, offset by +16,+16 — FR-CANVAS-015. */
export function duplicateSelection(): BoardObject[] {
  const state = boardStore.getState()
  const objects = selectedObjects()
  if (objects.length === 0) return []

  const copies = rekey(objects, DUPLICATE_OFFSET, DUPLICATE_OFFSET, nextZIndex)
  applyAndEmit(createOps(copies), LABELS.duplicate)
  state.setSelection(copies.map(o => o.id))
  return copies
}

/* ── Z-order, the slice the context menu needs ────────────────────────────── */

/**
 * Bring to front / send to back.
 *
 * `FR-CANVAS-016` is assigned to Phase 9, but Phase 5's context menu is
 * specified to contain both of these items (FLOWS §14.2 via the plan's §14.4
 * notes), and shipping a menu with two dead entries is worse than
 * implementing them. Only these two land here — bring-forward, send-backward
 * and the `]`/`[` shortcuts stay with the full requirement in Phase 9, as does
 * generating a key BETWEEN two neighbours.
 */
export function bringToFront(): void {
  const objects = selectedObjects()
  if (objects.length === 0) return
  // applyOps re-sorts the cached z-order when a zIndex changes, so there is no
  // separate reorder() call and no window where the two disagree.
  applyAndEmit(
    updateOps(objects.map(o => ({ ...o, zIndex: nextZIndex(), updatedAt: Date.now() }))),
    LABELS.reorder,
  )
}

export function sendToBack(): void {
  const state = boardStore.getState()
  const objects = selectedObjects()
  if (objects.length === 0) return

  // Keys below the current minimum. The fixture format is `a` + base-36, so
  // a shorter suffix sorts before every existing key lexicographically.
  const lowest = state.sortedIds[0]
  const base = lowest ? (state.objects.get(lowest)?.zIndex ?? 'a000000') : 'a000000'
  const parsed = Number.parseInt(base.slice(1), 36)
  const start = Number.isFinite(parsed) ? parsed : 0

  applyAndEmit(
    updateOps(
      objects.map((o, i) => ({
        ...o,
        zIndex: `a${Math.max(0, start - objects.length + i)
          .toString(36)
          .padStart(6, '0')}`,
        updatedAt: Date.now(),
      })),
    ),
    LABELS.reorder,
  )
}

/** Move the selection by a canvas delta. Used by the context menu's nudges. */
export const offsetObjects = (objects: readonly BoardObject[], dx: number, dy: number) =>
  objects.map(o => ({ ...o, x: clampCoord(o.x + dx), y: clampCoord(o.y + dy) }))
