import {
  clampCoord,
  type BoardObject,
  type ObjectId,
  type TextObject,
} from '@coboard/shared'
import {
  keysAfter,
  keysAfterTop,
  keysBefore,
  keysBeforeBottom,
} from '../../geometry/zIndex.js'
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
 * `FR-CANVAS-016` in full, from Phase 9: all four commands, and keys
 * generated BETWEEN two neighbours rather than only at the extremes.
 */

/** The four z-order commands, sharing one shape: pick keys, emit one batch. */
function reorderSelection(pick: (indices: number[]) => string[] | null): void {
  const objects = selectedObjects()
  if (objects.length === 0) return

  const { sortedIds } = boardStore.getState()
  const position = new Map(sortedIds.map((id, i) => [id, i]))
  // Sorted by current z, so relative order inside the selection is preserved.
  const ordered = [...objects].sort(
    (a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0),
  )

  const keys = pick(ordered.map(o => position.get(o.id) ?? 0))
  if (!keys) return

  // applyOps re-sorts the cached z-order when a zIndex changes, so there is no
  // separate reorder() call and no window where the two disagree.
  applyAndEmit(
    updateOps(ordered.map((o, i) => ({ ...o, zIndex: keys[i]!, updatedAt: Date.now() }))),
    LABELS.reorder,
  )
}

export function bringToFront(): void {
  reorderSelection(indices =>
    keysAfterTop(boardStore.getState().objects, boardStore.getState().sortedIds, indices.length),
  )
}

export function sendToBack(): void {
  reorderSelection(indices =>
    keysBeforeBottom(
      boardStore.getState().objects,
      boardStore.getState().sortedIds,
      indices.length,
    ),
  )
}

/**
 * One step up — FR-CANVAS-016.
 *
 * "Forward" means above the nearest object that is currently above the
 * selection, not above everything. Finding that neighbour is the only fiddly
 * part: it is the first id above the selection's TOP member that is not itself
 * selected, because stepping over another selected object would reorder the
 * selection against itself.
 */
export function bringForward(): void {
  const { objects, sortedIds } = boardStore.getState()
  const selected = new Set(selectedObjects().map(o => o.id))
  if (selected.size === 0) return

  let topIndex = -1
  for (let i = sortedIds.length - 1; i >= 0; i--) {
    if (selected.has(sortedIds[i]!)) {
      topIndex = i
      break
    }
  }
  // Find the first unselected object above it.
  let reference = -1
  for (let i = topIndex + 1; i < sortedIds.length; i++) {
    if (!selected.has(sortedIds[i]!)) {
      reference = i
      break
    }
  }
  // Already at the top — nothing to do, and emitting a no-op batch would put
  // a pointless entry on the undo stack.
  if (reference === -1) return

  reorderSelection(indices => keysAfter(objects, sortedIds, reference, indices.length))
}

export function sendBackward(): void {
  const { objects, sortedIds } = boardStore.getState()
  const selected = new Set(selectedObjects().map(o => o.id))
  if (selected.size === 0) return

  let bottomIndex = -1
  for (let i = 0; i < sortedIds.length; i++) {
    if (selected.has(sortedIds[i]!)) {
      bottomIndex = i
      break
    }
  }
  let reference = -1
  for (let i = bottomIndex - 1; i >= 0; i--) {
    if (!selected.has(sortedIds[i]!)) {
      reference = i
      break
    }
  }
  if (reference === -1) return

  reorderSelection(indices => keysBefore(objects, sortedIds, reference, indices.length))
}

/** Move the selection by a canvas delta. Used by the context menu's nudges. */
export const offsetObjects = (objects: readonly BoardObject[], dx: number, dy: number) =>
  objects.map(o => ({ ...o, x: clampCoord(o.x + dx), y: clampCoord(o.y + dy) }))
