import type { ObjectId } from '@coboard/shared'
import { boardStore } from '../../../stores/boardStore.js'
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
     * PHASE 9 SLOT: emit each op on the socket and add it to the outbox, the
     * same as `applyAndEmit` does. Not `applyRemoteOp` — these ops are ours.
     */
    boardStore.getState().applyOps(ops)
  },
  objectId => boardStore.getState().objects.has(objectId as ObjectId),
)
