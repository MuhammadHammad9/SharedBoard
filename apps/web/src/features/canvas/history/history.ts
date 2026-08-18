import type { ClientOp, ObjectId } from '@coboard/shared'
import { boardStore } from '../../../stores/boardStore.js'
import { emitOps } from '../../sync/persistence.js'
import { HistoryManager } from './HistoryManager.js'

/**
 * The application's single history stack, wired to the board store.
 *
 * It lives in its own module so the dependency graph stays a straight line:
 *
 *   HistoryManager.ts   knows nothing about the store
 *   history.ts          binds it to the store            ← you are here
 *   apply.ts            the LOCAL path, pushes to it
 *   applyRemote.ts      the REMOTE path, cannot see it
 *
 * Putting the singleton in `apply.ts` instead would make `apply → history →
 * apply` a cycle the moment undo needed to apply anything.
 */

export const history = new HistoryManager(
  ops => {
    /*
     * R-UNDO-003: an undo is applied and emitted as an ORDINARY op. There is
     * no "undo" message type, and remote clients see a normal change.
     *
     * Not `applyRemoteOp` — these ops are ours, and they must reach the
     * server like any other local change or the undone work reappears on the
     * next reload.
     */
    boardStore.getState().applyOps(ops)
    emitOps(withFreshIds(ops))
  },
  objectId => boardStore.getState().objects.has(objectId as ObjectId),
)

/**
 * Re-mint the op ids before sending.
 *
 * A history entry holds ONE `inverse` array and ONE `forward` array, and undo
 * → redo → undo replays the very same objects. Their op ids are the server's
 * idempotency keys (R-SYNC-014), so sending them a second time is re-acked as
 * a duplicate and writes nothing — the second undo would be visible locally
 * and absent from the database, and the divergence would only surface on
 * reload.
 *
 * Only the WIRE identity is new. The objectId and the payload are untouched,
 * so the change the server applies is exactly the change the user made.
 */
function withFreshIds(ops: readonly ClientOp[]): ClientOp[] {
  return ops.map(op => ({ ...op, id: crypto.randomUUID() }))
}
