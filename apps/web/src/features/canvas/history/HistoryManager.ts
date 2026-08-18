import type { ClientOp } from '@coboard/shared'
import { COALESCE_WINDOW_MS, type CoalesceKey, type HistoryLabel } from './grouping.js'

/**
 * Local undo and redo — FR-CANVAS-018, TRD §8.1, R-UNDO-001 … R-UNDO-010.
 *
 * PRD risk R-3 is High/High and its instruction is blunt: implement TRD §8
 * exactly, do not invent a variant. The stacks, the MAX, the unconditional
 * redo clear, the 10-attempt skip loop and the `isApplicable` predicate below
 * are all transcribed from §8.1 rather than designed.
 *
 * Three things this class deliberately does NOT do:
 *
 *   1. It does not import the store. `apply` and `exists` are injected, which
 *      is what lets the whole of undo be unit-tested against a plain Map, and
 *      what keeps `apply.ts` → `HistoryManager` a one-way edge instead of a
 *      cycle.
 *   2. It does not persist. R-UNDO-006: history dies with the page, on
 *      purpose. Restoring a stack across sessions produces undos that refer to
 *      a board the user no longer remembers.
 *   3. It does not distinguish local from remote, because it never sees a
 *      remote op. That separation lives one level up, in the two call paths —
 *      `applyAndEmit` reaches this class, `applyRemoteOp` cannot (R-UNDO-001).
 */

export interface HistoryEntry {
  /** What the user did. */
  forward: ClientOp[]
  /** What undoes it, built from the state BEFORE `forward` applied. */
  inverse: ClientOp[]
  /** Debugging, and a future history panel — TRD §8.1. */
  label: HistoryLabel | string
  /** Entries sharing a key inside COALESCE_WINDOW_MS fold into one. */
  coalesceKey?: CoalesceKey
}

/** R-UNDO-009: history depth is capped at 100 entries. */
export const HISTORY_MAX = 100

/** R-UNDO-005: at most 10 stale entries are skipped per keypress. */
export const MAX_SKIPS = 10

export type ApplyFn = (ops: readonly ClientOp[]) => void
export type ExistsFn = (objectId: string) => boolean

export class HistoryManager {
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  private lastPushAt = 0
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly apply: ApplyFn,
    private readonly exists: ExistsFn,
  ) {}

  /**
   * Record a completed user action.
   *
   * `at` is injected rather than read from the clock so the coalescence window
   * can be tested without fake timers — a test that has to freeze time to
   * assert on a 1-second window tends to assert on the freezing instead.
   */
  push(entry: HistoryEntry, at: number = Date.now()): void {
    // An entry that changes nothing is not an action. Pushing one would make
    // the next Ctrl+Z appear to do nothing at all.
    if (entry.forward.length === 0 || entry.inverse.length === 0) return

    const top = this.undoStack[this.undoStack.length - 1]
    if (
      top &&
      entry.coalesceKey !== undefined &&
      top.coalesceKey === entry.coalesceKey &&
      at - this.lastPushAt < COALESCE_WINDOW_MS
    ) {
      this.undoStack[this.undoStack.length - 1] = coalesce(top, entry)
    } else {
      this.undoStack.push(entry)
      // R-UNDO-009, FIFO: the OLDEST entry is evicted. Dropping the newest
      // instead would make the cap silently discard the action just taken.
      if (this.undoStack.length > HISTORY_MAX) this.undoStack.shift()
    }

    this.lastPushAt = at

    // R-UNDO-008: any new user action clears redo. Always. No exceptions.
    // Including when the entry coalesced — a coalesced keystroke is still a
    // new action, and the redo branch it would rejoin no longer exists.
    this.redoStack = []
    this.emit()
  }

  /**
   * Undo — TRD §8.1, FLOWS §8.2.5.
   *
   * Returns the entry that was undone, or null when the stack held nothing
   * applicable. The caller does not need the value; tests do.
   */
  undo(): HistoryEntry | null {
    let attempts = 0
    while (this.undoStack.length > 0 && attempts++ < MAX_SKIPS) {
      const entry = this.undoStack.pop()!
      // R-UNDO-005: a stale entry is dropped silently and the next tried. It
      // is not an error and it is not surfaced — the object it named was
      // deleted by someone else, and telling the user that mid-Ctrl+Z helps
      // nobody.
      if (!this.isApplicable(entry.inverse)) continue

      this.apply(entry.inverse)
      this.redoStack.push(entry)
      // A coalescing burst cannot span an undo: the next keystroke starts a
      // fresh entry rather than merging into the one just moved to redo.
      this.lastPushAt = 0
      this.emit()
      return entry
    }
    // The stack may have shrunk even when nothing applied — every skipped
    // entry was popped, which is the point of the cap.
    this.emit()
    return null
  }

  /** Redo — symmetric, and deliberately NOT a new action, so redo survives. */
  redo(): HistoryEntry | null {
    let attempts = 0
    while (this.redoStack.length > 0 && attempts++ < MAX_SKIPS) {
      const entry = this.redoStack.pop()!
      if (!this.isApplicable(entry.forward)) continue

      this.apply(entry.forward)
      this.undoStack.push(entry)
      if (this.undoStack.length > HISTORY_MAX) this.undoStack.shift()
      this.lastPushAt = 0
      this.emit()
      return entry
    }
    this.emit()
    return null
  }

  /**
   * An entry is stale when it targets an object that no longer exists — TRD
   * §8.1. A CREATE is always applicable: it is what brings the object back.
   */
  private isApplicable(ops: readonly ClientOp[]): boolean {
    return ops.every(op => op.type === 'CREATE' || this.exists(op.objectId))
  }

  /* ── Read side. Bound so React can pass them straight to a hook. ────────── */

  readonly canUndo = (): boolean => this.undoStack.length > 0
  readonly canRedo = (): boolean => this.redoStack.length > 0
  readonly undoDepth = (): number => this.undoStack.length
  readonly redoDepth = (): number => this.redoStack.length

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /** R-UNDO-006 has no reset requirement; this exists for tests and for the
   *  board unmount, where a stack referring to a different board is worse than
   *  no stack at all. */
  clear(): void {
    this.undoStack = []
    this.redoStack = []
    this.lastPushAt = 0
    this.emit()
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }
}

/**
 * Fold two entries into one — the typing row of TRD §8.4.
 *
 * The net action is `prev` then `next`, so the net inverse is next's inverse
 * followed by prev's: unwind the later change first, exactly as `buildInverse`
 * reverses a batch. Both sides are then collapsed so a burst of two hundred
 * keystrokes on one note stays two ops rather than four hundred.
 */
function coalesce(prev: HistoryEntry, next: HistoryEntry): HistoryEntry {
  return {
    label: next.label,
    coalesceKey: next.coalesceKey,
    forward: collapseUpdates([...prev.forward, ...next.forward]),
    inverse: collapseUpdates([...next.inverse, ...prev.inverse]),
  }
}

/**
 * Merge runs of consecutive UPDATEs on the same object into one op.
 *
 * Last write wins per key, which is correct in both directions: forward, the
 * newest keystroke's text is the one the user sees; inverse, the oldest
 * captured value is the one the burst started from, and it is last in the
 * reversed order.
 *
 * Only CONSECUTIVE ops merge. Folding across an intervening op on another
 * object would reorder the batch, and order is the difference between a
 * correct undo and a broken one wherever two ops touch the same thing.
 */
function collapseUpdates(ops: readonly ClientOp[]): ClientOp[] {
  const out: ClientOp[] = []
  for (const op of ops) {
    const last = out[out.length - 1]
    if (
      op.type === 'UPDATE' &&
      last &&
      last.type === 'UPDATE' &&
      last.objectId === op.objectId
    ) {
      out[out.length - 1] = {
        ...last,
        payload: { ...last.payload, ...op.payload },
      }
      continue
    }
    out.push(op)
  }
  return out
}
