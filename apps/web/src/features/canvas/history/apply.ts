import type { BoardObject, ClientOp, ObjectId } from '@coboard/shared'
import { boardStore } from '../../../stores/boardStore.js'
import { history } from './history.js'
import {
  buildInverse,
  createOp,
  deleteOp,
  diffOp,
  type ObjectReader,
} from './inverseOps.js'
import { emitOps } from '../../sync/persistence.js'
import type { CoalesceKey } from './grouping.js'

/**
 * The LOCAL write path — TRD §8.3 rule 1, R-UNDO-001 (Blocking).
 *
 * There are exactly two ways the document changes, and they are separate
 * modules on purpose:
 *
 *   applyAndEmit   (here)            local action → store, history, outbox
 *   applyRemoteOp  (applyRemote.ts)  arriving op  → store. Nothing else.
 *
 * Phase 9 is when that separation starts mattering, and Phase 9 is far too
 * late to introduce it: by then there would be a dozen call sites to audit and
 * the bug — "undo reverted my teammate's work" — is invisible in single-player
 * testing. Establishing it now makes the bug structurally impossible rather
 * than merely absent, which is what the exit gate asks for.
 *
 * Every local mutation in the app funnels through this function. That is also
 * what makes the R-UNDO-007 ordering rule hold everywhere at once: the inverse
 * is built HERE, before the store is touched, so no call site can forget to
 * capture the previous values first.
 */

export interface ApplyOptions {
  /**
   * Reads the document as it was BEFORE these ops.
   *
   * Defaults to the live store, which is correct for every action that commits
   * in one go — a stroke, a paste, a delete, a colour change.
   *
   * The live-mutating gestures need the override. A drag rewrites its objects
   * on every pointermove, so by `pointerup` the store no longer remembers
   * where anything started; the pointerdown snapshot in `interaction.origin`
   * does, and that is what gets passed here. The forward ops are then a
   * re-application of values already in the store, which is a harmless no-op,
   * and the inverse comes out of the snapshot exactly as R-UNDO-007 requires.
   */
  before?: ObjectReader
  /** Entries sharing a key inside the 1 s window fold into one — TRD §8.4. */
  coalesceKey?: CoalesceKey
}

const liveReader: ObjectReader = id => boardStore.getState().objects.get(id)

/**
 * Apply a batch of ops locally, record one undo entry, and emit for persistence.
 *
 * ONE call is ONE history entry, whatever the batch size — R-UNDO-004. That is
 * why every commit path takes an array: dragging ten objects is one action and
 * must be one Ctrl+Z, not ten.
 *
 * Returns false when the batch was empty or its inverse could not be built, in
 * which case nothing was applied and nothing was recorded.
 */
export function applyAndEmit(
  ops: readonly ClientOp[],
  label: string,
  options: ApplyOptions = {},
): boolean {
  if (ops.length === 0) return false

  /*
   * R-UNDO-007 (Blocking), and the one line in this file that must not move.
   * The inverse is built from the pre-mutation document. One statement later
   * the previous values are gone.
   */
  const inverse = buildInverse(ops, options.before ?? liveReader)

  boardStore.getState().applyOps(ops)

  /*
   * Persist. One call is one batch, which is what keeps a ten-object drag a
   * single request rather than ten (R-SYNC-017, FLOWS E-07).
   *
   * Deliberately AFTER the local apply and never awaited. The user's own
   * change must land on their screen at pointer speed; whether it has reached
   * Postgres yet is the outbox's problem, not theirs. Phase 9 swaps the
   * transport underneath this line for the socket.
   */
  emitOps(ops)

  // An un-invertible batch is applied but not recorded. Dropping the entry is
  // deliberate: a partial inverse would restore the board to a state the user
  // never occupied, which is worse than an action that cannot be undone.
  if (!inverse) return false

  history.push({ forward: [...ops], inverse, label, coalesceKey: options.coalesceKey })
  return true
}

/* ── Op builders for the shapes the handlers actually commit ──────────────── */

/** One or more freshly built objects. Stroke, shape, sticky, text, paste. */
export const createOps = (objects: readonly BoardObject[]): ClientOp[] =>
  objects.map(createOp)

/** A deletion. The inverse CREATEs are read out of the store by applyAndEmit. */
export const deleteOps = (ids: readonly ObjectId[]): ClientOp[] => ids.map(deleteOp)

/**
 * Objects the caller has already transformed, expressed as minimal UPDATEs.
 *
 * `next` holds the finished objects; `before` reads their pre-gesture state.
 * Objects that did not actually change produce no op at all, so a click that
 * never became a drag leaves the history stack alone.
 */
export function updateOps(
  next: readonly BoardObject[],
  before: ObjectReader = liveReader,
): ClientOp[] {
  const ops: ClientOp[] = []
  for (const after of next) {
    const previous = before(after.id)
    if (!previous) continue
    const op = diffOp(previous, after)
    if (op) ops.push(op)
  }
  return ops
}

/** A reader over a snapshot taken at pointerdown — the drag/resize/rotate path. */
export const snapshotReader =
  (origin: ReadonlyMap<ObjectId, BoardObject>): ObjectReader =>
  id =>
    origin.get(id)
