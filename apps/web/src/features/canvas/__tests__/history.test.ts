import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  strokeBounds,
  type BoardObject,
  type ClientOp,
  type ObjectId,
  type StrokeObject,
} from '@coboard/shared'
import { boardStore } from '../../../stores/boardStore.js'
import {
  HISTORY_MAX,
  HistoryManager,
  MAX_SKIPS,
  type HistoryEntry,
} from '../history/HistoryManager.js'
import { COALESCE_WINDOW_MS, LABELS, nudgeKey, typingKey } from '../history/grouping.js'
import {
  buildInverse,
  createOp,
  deleteOp,
  diffOp,
  invertOp,
  updateOp,
} from '../history/inverseOps.js'
import { applyAndEmit, createOps, deleteOps } from '../history/apply.js'
import { applyRemoteOp } from '../history/applyRemote.js'
import { history } from '../history/history.js'
import { beginDraw, appendPoint, commitDraw } from '../interaction/handlers/draw.js'
import {
  beginDrag,
  endDrag,
  nudgeSelection,
  updateDrag,
} from '../interaction/handlers/transform.js'
import { beginErase, endErase, eraseAt } from '../interaction/handlers/erase.js'
import { duplicateSelection } from '../interaction/handlers/clipboardActions.js'

/**
 * Undo and redo — FR-CANVAS-018, TRD §8, R-UNDO-001 … R-UNDO-010,
 * PRD acceptance tests AT-40 … AT-44.
 *
 * Three layers, deliberately separated:
 *
 *   1. HistoryManager against a plain Map. No store, no handlers. This is
 *      where the stack semantics — the cap, the skip loop, the redo clear,
 *      coalescence — are pinned down, because they are the part PRD risk R-3
 *      says not to improvise.
 *   2. Inverse construction, as pure functions.
 *   3. The real handlers against the real store, which is the only level that
 *      can prove the grouping table in TRD §8.4 actually holds end to end.
 */

let seq = 0
function makeStroke(x: number, y: number, size = 20): StrokeObject {
  seq++
  const points = [x, y, 0.5, x + size, y + size, 0.5]
  const box = strokeBounds(points, 2)
  return {
    id: (`${seq}`.padStart(8, '0') + '-0000-4000-8000-000000000000') as ObjectId,
    type: 'stroke',
    ...box,
    rotation: 0,
    zIndex: `a${`${seq}`.padStart(6, '0')}`,
    opacity: 1,
    createdBy: 'test',
    createdAt: 0,
    updatedAt: 0,
    points,
    color: '#18181B',
    strokeWidth: 2,
    simplified: true,
  } as StrokeObject
}

let uuidSeq = 0
beforeEach(() => {
  seq = 0
  // Offset well clear of the fixture ids below, which share this format —
  // overlapping them made a duplicate silently overwrite its own original.
  uuidSeq = 1_000
  history.clear()
  boardStore.setState({
    objects: new Map(),
    objectsVersion: 0,
    sortedIds: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    activeTool: 'select',
    interaction: { type: 'IDLE' },
    selection: [],
    eraseCandidate: null,
    editingTextId: null,
    draft: null,
    draftVersion: 0,
  })
  vi.stubGlobal('crypto', {
    randomUUID: () =>
      `${(++uuidSeq).toString().padStart(8, '0')}-0000-4000-8000-000000000000`,
  })
})

const load = (objects: BoardObject[]) => boardStore.getState().loadObjects(objects)
const objectIds = () => [...boardStore.getState().sortedIds]
const get = (id: ObjectId) => boardStore.getState().objects.get(id)

/**
 * A stable state hash — the same idea as the ?debug=1 overlay's (CLAUDE.md
 * §5.1). "The board returned to its starting state" is only a real assertion
 * if it compares the whole document, not an object count.
 */
function hashBoard(): string {
  return JSON.stringify(
    [...boardStore.getState().objects.values()]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map(o => ({
        ...o,
        x: Math.round(o.x * 100) / 100,
        y: Math.round(o.y * 100) / 100,
        // Timestamps are display-only (R-CONV-010) and a transform rewrites
        // them, so an undo restores geometry without restoring the clock.
        updatedAt: 0,
      })),
  )
}

/* ── 1. The stack itself, with no store attached ──────────────────────────── */

describe('HistoryManager — TRD §8.1', () => {
  /** A toy document, so stack semantics are tested without the real store. */
  function harness() {
    const objects = new Map<string, { id: string; v: number }>()
    const applied: ClientOp[][] = []
    const manager = new HistoryManager(
      ops => {
        applied.push([...ops])
        for (const op of ops) {
          if (op.type === 'CREATE') objects.set(op.objectId, { id: op.objectId, v: 0 })
          else if (op.type === 'DELETE') objects.delete(op.objectId)
          else objects.set(op.objectId, { id: op.objectId, ...op.payload } as never)
        }
      },
      id => objects.has(id),
    )
    return { objects, applied, manager }
  }

  const entry = (id: string, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
    forward: [updateOp(id as ObjectId, { v: 1 })],
    inverse: [updateOp(id as ObjectId, { v: 0 })],
    label: LABELS.style,
    ...over,
  })

  it('starts empty and reports both stacks as unavailable', () => {
    const { manager } = harness()
    expect(manager.canUndo()).toBe(false)
    expect(manager.canRedo()).toBe(false)
    expect(manager.undo()).toBeNull()
    expect(manager.redo()).toBeNull()
  })

  it('undo applies the inverse and moves the entry to the redo stack', () => {
    const { manager, objects, applied } = harness()
    objects.set('a', { id: 'a', v: 1 })

    manager.push(entry('a'))
    expect(manager.canUndo()).toBe(true)

    manager.undo()
    expect(applied).toEqual([[expect.objectContaining({ payload: { v: 0 } })]])
    expect(manager.canUndo()).toBe(false)
    expect(manager.canRedo()).toBe(true)
  })

  it('redo re-applies the FORWARD ops and restores the undo stack', () => {
    const { manager, objects, applied } = harness()
    objects.set('a', { id: 'a', v: 1 })

    manager.push(entry('a'))
    manager.undo()
    manager.redo()

    expect(applied[1]).toEqual([expect.objectContaining({ payload: { v: 1 } })])
    expect(manager.canUndo()).toBe(true)
    expect(manager.canRedo()).toBe(false)
  })

  it('R-UNDO-008: any new action clears the redo stack. Always', () => {
    const { manager, objects } = harness()
    objects.set('a', { id: 'a', v: 1 })

    manager.push(entry('a'))
    manager.undo()
    expect(manager.canRedo()).toBe(true)

    manager.push(entry('a'))
    expect(manager.canRedo()).toBe(false)
  })

  it('R-UNDO-009: caps at 100 entries and evicts the OLDEST', () => {
    const { manager, objects } = harness()
    objects.set('a', { id: 'a', v: 1 })

    for (let i = 0; i < HISTORY_MAX + 25; i++) {
      manager.push({ ...entry('a'), label: `push-${i}` })
    }
    expect(manager.undoDepth()).toBe(HISTORY_MAX)
    // The newest survives; the oldest is what went.
    expect(manager.undo()?.label).toBe(`push-${HISTORY_MAX + 24}`)
  })

  it('R-UNDO-005: a stale entry is skipped SILENTLY and the next tried', () => {
    const { manager, objects } = harness()
    objects.set('alive', { id: 'alive', v: 1 })

    manager.push({ ...entry('gone'), label: 'stale' })
    manager.push({ ...entry('alive'), label: 'good' })
    // The object the top entry names was deleted by someone else.
    manager.undo() // consumes 'good'
    const undone = manager.undo() // 'stale' is skipped, nothing is left

    expect(undone).toBeNull()
    expect(manager.undoDepth()).toBe(0)
  })

  it('R-UNDO-005 / AT-41: skipping is capped at 10 attempts per keypress', () => {
    const { manager, objects } = harness()
    objects.set('alive', { id: 'alive', v: 1 })

    // 12 stale entries buried under nothing applicable within reach.
    for (let i = 0; i < 12; i++) manager.push(entry(`gone-${i}`))
    manager.push({ ...entry('alive'), label: 'reachable' })

    manager.undo() // 'reachable'
    expect(manager.undo()).toBeNull() // 10 skips, then gives up
    // Exactly MAX_SKIPS entries were consumed by the attempt — that is what
    // stops a thousand stale entries freezing the tab on one keypress.
    expect(manager.undoDepth()).toBe(12 - MAX_SKIPS)
  })

  it('AT-41: undoing onto a deleted object is a no-op, not a resurrection', () => {
    const { manager, objects } = harness()
    manager.push(entry('deleted-by-someone-else'))
    expect(() => manager.undo()).not.toThrow()
    expect(objects.has('deleted-by-someone-else')).toBe(false)
  })

  it('a CREATE inverse is always applicable — it is what brings the object back', () => {
    const { manager, objects } = harness()
    const object = { id: 'x', type: 'stroke' } as unknown as BoardObject
    manager.push({
      forward: [deleteOp('x' as ObjectId)],
      inverse: [createOp({ ...object, id: 'x' as ObjectId })],
      label: LABELS.delete,
    })
    manager.undo()
    expect(objects.has('x')).toBe(true)
  })

  it('refuses an entry with no ops — a change of nothing is not an action', () => {
    const { manager } = harness()
    manager.push({ forward: [], inverse: [], label: LABELS.style })
    expect(manager.canUndo()).toBe(false)
  })
})

describe('coalescence — TRD §8.4, the typing row', () => {
  function harness() {
    const objects = new Map<string, unknown>([['note', {}]])
    return new HistoryManager(
      () => {},
      id => objects.has(id),
    )
  }

  const typed = (text: string, previous: string): HistoryEntry => ({
    forward: [updateOp('note' as ObjectId, { text })],
    inverse: [updateOp('note' as ObjectId, { text: previous })],
    label: LABELS.typing,
    coalesceKey: typingKey('note' as ObjectId),
  })

  it('folds keystrokes on the same object inside the 1 s window into ONE entry', () => {
    const manager = harness()
    manager.push(typed('h', ''), 1_000)
    manager.push(typed('he', 'h'), 1_200)
    manager.push(typed('hel', 'he'), 1_500)

    expect(manager.undoDepth()).toBe(1)
    const entry = manager.undo()!
    // The forward is the LATEST text; the inverse is what the burst started
    // from — not the previous keystroke.
    expect(entry.forward).toEqual([expect.objectContaining({ payload: { text: 'hel' } })])
    expect(entry.inverse).toEqual([expect.objectContaining({ payload: { text: '' } })])
  })

  it('starts a new entry once the window lapses', () => {
    const manager = harness()
    manager.push(typed('a', ''), 0)
    manager.push(typed('ab', 'a'), COALESCE_WINDOW_MS + 1)
    expect(manager.undoDepth()).toBe(2)
  })

  it('does not fold across different objects', () => {
    const manager = harness()
    manager.push(typed('a', ''), 0)
    manager.push({ ...typed('z', ''), coalesceKey: typingKey('other' as ObjectId) }, 100)
    expect(manager.undoDepth()).toBe(2)
  })

  it('never folds entries with no coalesce key, however fast they arrive', () => {
    const manager = harness()
    const stroke: HistoryEntry = {
      forward: [updateOp('note' as ObjectId, { v: 1 })],
      inverse: [updateOp('note' as ObjectId, { v: 0 })],
      label: LABELS.draw,
    }
    manager.push(stroke, 0)
    manager.push(stroke, 1)
    // Two strokes a millisecond apart are still two strokes.
    expect(manager.undoDepth()).toBe(2)
  })

  it('R-UNDO-008 holds through a coalesce — a folded keystroke still clears redo', () => {
    const manager = harness()
    manager.push(typed('a', ''), 0)
    manager.undo()
    expect(manager.canRedo()).toBe(true)
    manager.push(typed('b', ''), 10)
    expect(manager.canRedo()).toBe(false)
  })

  it('an undo breaks the burst — the next keystroke does not rejoin it', () => {
    const manager = harness()
    manager.push(typed('a', ''), 0)
    manager.push(typed('ab', 'a'), 50)
    manager.undo()
    manager.push(typed('x', ''), 60)
    expect(manager.undoDepth()).toBe(1)
  })
})

/* ── 2. Inverse construction ──────────────────────────────────────────────── */

describe('inverse ops — TRD §8.2, R-UNDO-007', () => {
  const read = (o: BoardObject) => (id: ObjectId) => (id === o.id ? o : undefined)

  it('CREATE inverts to DELETE', () => {
    const o = makeStroke(0, 0)
    const inverse = invertOp(createOp(o), read(o))!
    expect(inverse.type).toBe('DELETE')
    expect(inverse.objectId).toBe(o.id)
  })

  it('DELETE inverts to a CREATE carrying the WHOLE object', () => {
    const o = makeStroke(5, 7)
    const inverse = invertOp(deleteOp(o.id), read(o))!
    expect(inverse.type).toBe('CREATE')
    // Anything less than the full object and undo restores a husk.
    expect(inverse.payload).toEqual(o)
  })

  it('UPDATE inverts to ONLY the keys being changed', () => {
    const o = { ...makeStroke(0, 0), color: '#EF4444', opacity: 0.5 }
    const inverse = invertOp(updateOp(o.id, { color: '#000000' }), read(o))!
    // opacity is NOT in the inverse. Including it is what makes undo clobber
    // a teammate's concurrent edit to a field this action never touched.
    expect(inverse.payload).toEqual({ color: '#EF4444' })
  })

  it('returns null for an UPDATE or DELETE naming an object that is not there', () => {
    const missing = () => undefined
    expect(invertOp(updateOp('x' as ObjectId, { a: 1 }), missing)).toBeNull()
    expect(invertOp(deleteOp('x' as ObjectId), missing)).toBeNull()
  })

  it('buildInverse REVERSES the batch', () => {
    const a = makeStroke(0, 0)
    const b = makeStroke(50, 50)
    const lookup = (id: ObjectId) => (id === a.id ? a : id === b.id ? b : undefined)

    const inverse = buildInverse([createOp(a), createOp(b)], lookup)!
    // Undoing a paste that created A then B must delete B first.
    expect(inverse.map(op => op.objectId)).toEqual([b.id, a.id])
  })

  it('buildInverse returns null when ANY op cannot be inverted', () => {
    const a = makeStroke(0, 0)
    const lookup = (id: ObjectId) => (id === a.id ? a : undefined)
    // A partial inverse would leave the board in a state nobody occupied.
    expect(
      buildInverse([deleteOp(a.id), deleteOp('gone' as ObjectId)], lookup),
    ).toBeNull()
  })
})

describe('diffOp — minimal UPDATEs for the live-mutating gestures', () => {
  it('names only the keys that actually changed', () => {
    const before = makeStroke(0, 0)
    const after = { ...before, x: 40, updatedAt: 999 }
    expect(diffOp(before, after)!.payload).toEqual({ x: 40, updatedAt: 999 })
  })

  it('returns null when only updatedAt moved', () => {
    const before = makeStroke(0, 0)
    // Every transform rewrites the timestamp; on its own it is not evidence
    // that anything moved, and it must not produce an undo entry.
    expect(diffOp(before, { ...before, updatedAt: 12_345 })).toBeNull()
  })

  it('compares point arrays by VALUE, not by reference', () => {
    const before = makeStroke(0, 0)
    // A rebuilt-but-identical array is not a change.
    const after = { ...before, points: [...before.points] }
    expect(diffOp(before, after)).toBeNull()

    const moved = { ...before, points: [...before.points.slice(0, 1), 99, 0.5] }
    expect(diffOp(before, moved)).not.toBeNull()
  })
})

/* ── 3. applyOps, the shared write path ───────────────────────────────────── */

describe('boardStore.applyOps — TRD §5.2, R-CONV-002', () => {
  it('merges an UPDATE payload PARTIALLY', () => {
    const o = makeStroke(0, 0)
    load([o])
    boardStore.getState().applyOps([updateOp(o.id, { color: '#EF4444' })])

    const after = get(o.id)!
    expect((after as StrokeObject).color).toBe('#EF4444')
    // Everything the payload did not name survives. Replacing the whole object
    // is what turns every concurrent edit into a lost update.
    expect((after as StrokeObject).points).toEqual(o.points)
  })

  it('drops an UPDATE for an object that is not present', () => {
    boardStore.getState().applyOps([updateOp('ghost' as ObjectId, { x: 5 })])
    expect(boardStore.getState().objects.size).toBe(0)
  })

  it('keeps sortedIds in z-order across creates and deletes', () => {
    const a = makeStroke(0, 0)
    const b = makeStroke(10, 10)
    const c = makeStroke(20, 20)
    load([a, c])

    // b's key sorts between a's and c's, so it must be SPLICED into the middle
    // rather than appended.
    expect(b.zIndex > a.zIndex && b.zIndex < c.zIndex).toBe(true)
    boardStore.getState().applyOps([createOp(b)])
    expect(objectIds()).toEqual([a.id, b.id, c.id])

    boardStore.getState().applyOps([deleteOp(a.id)])
    expect(objectIds()).toEqual([b.id, c.id])
  })

  it('re-sorts when an UPDATE changes a zIndex', () => {
    const a = makeStroke(0, 0)
    const b = makeStroke(10, 10)
    load([a, b])
    boardStore.getState().applyOps([updateOp(a.id, { zIndex: 'a999999' })])
    expect(objectIds()).toEqual([b.id, a.id])
  })

  it('prunes the selection and the erase candidate when their object goes', () => {
    const a = makeStroke(0, 0)
    load([a])
    boardStore.setState({ selection: [a.id], eraseCandidate: a.id })
    boardStore.getState().applyOps([deleteOp(a.id)])
    expect(boardStore.getState().selection).toEqual([])
    expect(boardStore.getState().eraseCandidate).toBeNull()
  })

  it('bumps objectsVersion exactly once for a whole batch', () => {
    load([makeStroke(0, 0)])
    const before = boardStore.getState().objectsVersion
    boardStore
      .getState()
      .applyOps(createOps([makeStroke(1, 1), makeStroke(2, 2), makeStroke(3, 3)]))
    // One repaint for the batch, not three — E-07.
    expect(boardStore.getState().objectsVersion).toBe(before + 1)
  })
})

/* ── 4. The two code paths ────────────────────────────────────────────────── */

describe('R-UNDO-001 (Blocking) — applyRemoteOp never touches history', () => {
  it('applies the op to the document', () => {
    const o = makeStroke(0, 0)
    applyRemoteOp(createOps([o]))
    expect(get(o.id)).toBeDefined()
  })

  it('pushes NOTHING onto the undo stack, for creates, updates and deletes', () => {
    const push = vi.spyOn(history, 'push')
    const o = makeStroke(0, 0)

    applyRemoteOp(createOps([o]))
    applyRemoteOp([updateOp(o.id, { color: '#EF4444' })])
    applyRemoteOp(deleteOps([o.id]))

    // This is the bug the whole phase exists to prevent: undo reverting a
    // teammate's work.
    expect(push).not.toHaveBeenCalled()
    expect(history.canUndo()).toBe(false)
    push.mockRestore()
  })

  it('is STRUCTURALLY incapable of it — the module imports no history at all', () => {
    /*
     * A spy proves the current code does not call push. This proves the next
     * person cannot make it, without the build going red first. R-UNDO-001 is
     * Blocking and Phase 9 is when it starts costing real bugs, so the rule
     * gets an enforcement that does not depend on anyone remembering it.
     */
    const source = readFileSync(
      fileURLToPath(new URL('../history/applyRemote.ts', import.meta.url)),
      'utf8',
    )
    const imports = source.match(/^\s*import[\s\S]*?from\s+'([^']+)'/gm) ?? []
    for (const line of imports) {
      expect(line).not.toMatch(/history|History/)
    }
  })

  it('applyAndEmit, by contrast, records exactly one entry per call', () => {
    const o = makeStroke(0, 0)
    applyAndEmit(createOps([o]), LABELS.draw)
    expect(history.undoDepth()).toBe(1)
  })
})

describe('applyAndEmit — R-UNDO-007 ordering', () => {
  it('captures the previous values BEFORE mutating', () => {
    const o = { ...makeStroke(0, 0), color: '#18181B' }
    load([o])
    applyAndEmit([updateOp(o.id, { color: '#EF4444' })], LABELS.style)
    expect((get(o.id) as StrokeObject).color).toBe('#EF4444')

    history.undo()
    // If the inverse had been built after the mutation it would say #EF4444
    // and undo would be a no-op.
    expect((get(o.id) as StrokeObject).color).toBe('#18181B')
  })

  it('records nothing for an empty batch', () => {
    expect(applyAndEmit([], LABELS.style)).toBe(false)
    expect(history.canUndo()).toBe(false)
  })
})

/* ── 5. The grouping table, through the real handlers ─────────────────────── */

describe('grouping — TRD §8.4, R-UNDO-010', () => {
  it('one stroke is ONE entry, and undo removes it', () => {
    boardStore.getState().setActiveTool('pen')
    beginDraw(1, 0, 0, 0.5)
    for (let i = 1; i <= 20; i++) appendPoint(i * 4, i * 2, 0.5)
    const stroke = commitDraw(null)!

    expect(history.undoDepth()).toBe(1)
    expect(get(stroke.id)).toBeDefined()

    history.undo()
    expect(get(stroke.id)).toBeUndefined()

    history.redo()
    expect(get(stroke.id)).toBeDefined()
  })

  it('dragging N objects is ONE entry containing N ops', () => {
    const a = makeStroke(0, 0)
    const b = makeStroke(100, 100)
    load([a, b])
    boardStore.getState().setSelection([a.id, b.id])

    beginDrag(1, 0, 0)
    updateDrag(60, 40, false)
    endDrag(null)

    expect(history.undoDepth()).toBe(1)
    expect(get(a.id)!.x).toBeCloseTo(a.x + 60)
    expect(get(b.id)!.x).toBeCloseTo(b.x + 60)

    history.undo()
    // R-UNDO-004: one keypress moves all of them back.
    expect(get(a.id)!.x).toBeCloseTo(a.x)
    expect(get(b.id)!.x).toBeCloseTo(b.x)
  })

  it('a click that never became a drag records nothing', () => {
    const a = makeStroke(0, 0)
    load([a])
    boardStore.getState().setSelection([a.id])
    beginDrag(1, 0, 0)
    updateDrag(0.5, 0.5, false) // below DRAG_THRESHOLD
    endDrag(null)
    expect(history.canUndo()).toBe(false)
  })

  it('an eraser sweep across N objects is ONE entry', () => {
    const objects = [makeStroke(0, 0), makeStroke(40, 40), makeStroke(80, 80)]
    load(objects)
    boardStore.getState().setActiveTool('eraser')

    beginErase(1, 5, 5)
    eraseAt(45, 45)
    eraseAt(85, 85)
    endErase(null)

    expect(boardStore.getState().objects.size).toBe(0)
    expect(history.undoDepth()).toBe(1)

    history.undo()
    // Restored whole, not as ids — the inverse CREATEs carry the objects.
    expect(boardStore.getState().objects.size).toBe(3)
    expect(get(objects[1]!.id)).toEqual(objects[1])
  })

  it('a delete of a multi-selection is ONE entry and restores everything', () => {
    const objects = [makeStroke(0, 0), makeStroke(40, 40), makeStroke(80, 80)]
    load(objects)
    const before = hashBoard()

    applyAndEmit(deleteOps(objects.map(o => o.id)), LABELS.delete)
    expect(boardStore.getState().objects.size).toBe(0)
    expect(history.undoDepth()).toBe(1)

    history.undo()
    expect(hashBoard()).toBe(before)
  })

  it('duplicating N objects is ONE entry', () => {
    const objects = [makeStroke(0, 0), makeStroke(40, 40)]
    load(objects)
    boardStore.getState().setSelection(objects.map(o => o.id))

    duplicateSelection()
    expect(boardStore.getState().objects.size).toBe(4)
    expect(history.undoDepth()).toBe(1)

    history.undo()
    expect(boardStore.getState().objects.size).toBe(2)
  })

  it('a held arrow key coalesces into one entry per burst', () => {
    const a = makeStroke(0, 0)
    load([a])
    boardStore.getState().setSelection([a.id])

    for (let i = 0; i < 10; i++) nudgeSelection(1, 0)
    expect(get(a.id)!.x).toBeCloseTo(a.x + 10)
    // Ten key repeats, one Ctrl+Z.
    expect(history.undoDepth()).toBe(1)

    history.undo()
    expect(get(a.id)!.x).toBeCloseTo(a.x)
  })

  it('the nudge key is per selection, so a different object starts a new entry', () => {
    const a = makeStroke(0, 0)
    const b = makeStroke(100, 0)
    expect(nudgeKey([a.id])).not.toBe(nudgeKey([b.id]))
    // Order within a selection must not matter.
    expect(nudgeKey([a.id, b.id])).toBe(nudgeKey([b.id, a.id]))
  })
})

/* ── 6. The PRD acceptance tests that do not need two browsers ────────────── */

describe('PRD §11.5 acceptance', () => {
  it('AT-42: ten actions, ten undos, back to the starting state', () => {
    const start = [makeStroke(0, 0), makeStroke(200, 200)]
    load(start)
    const before = hashBoard()

    boardStore.getState().setSelection([start[0]!.id])
    for (let i = 0; i < 10; i++) {
      applyAndEmit(createOps([makeStroke(i * 30, 400)]), LABELS.draw)
    }
    expect(boardStore.getState().objects.size).toBe(12)
    expect(history.undoDepth()).toBe(10)

    for (let i = 0; i < 10; i++) history.undo()
    expect(hashBoard()).toBe(before)
    expect(history.canUndo()).toBe(false)
  })

  it('AT-43: five undos then five redos is identical to before the undos', () => {
    load([makeStroke(0, 0)])
    for (let i = 0; i < 5; i++) {
      applyAndEmit(createOps([makeStroke(i * 30, 400)]), LABELS.draw)
    }
    const before = hashBoard()

    for (let i = 0; i < 5; i++) history.undo()
    expect(boardStore.getState().objects.size).toBe(1)

    for (let i = 0; i < 5; i++) history.redo()
    expect(hashBoard()).toBe(before)
  })

  it('AT-44: undo, then a new action, and redo does nothing', () => {
    load([makeStroke(0, 0)])
    applyAndEmit(createOps([makeStroke(50, 50)]), LABELS.draw)
    history.undo()
    expect(history.canRedo()).toBe(true)

    applyAndEmit(createOps([makeStroke(90, 90)]), LABELS.draw)

    expect(history.canRedo()).toBe(false)
    const after = hashBoard()
    history.redo()
    expect(hashBoard()).toBe(after)
  })

  it('AT-41: A moves an object, someone else deletes it, A undoes — no-op', () => {
    const a = makeStroke(0, 0)
    load([a])
    boardStore.getState().setSelection([a.id])

    beginDrag(1, 0, 0)
    updateDrag(80, 0, false)
    endDrag(null)

    // The remote path, deliberately: this is exactly the collaboration the
    // rule is about, and it must not put anything on A's stack.
    applyRemoteOp(deleteOps([a.id]))
    expect(history.undoDepth()).toBe(1)

    expect(() => history.undo()).not.toThrow()
    // No crash, and no resurrection.
    expect(get(a.id)).toBeUndefined()
    expect(history.undoDepth()).toBe(0)
  })
})
