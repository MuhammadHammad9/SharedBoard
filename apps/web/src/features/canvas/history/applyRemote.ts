import type { ClientOp } from '@coboard/shared'
import { boardStore } from '../../../stores/boardStore.js'

/**
 * The REMOTE write path — TRD §8.3 rule 1, R-UNDO-001 (Blocking).
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  THIS MODULE MUST NEVER IMPORT THE HISTORY STACK.                    │
 * │                                                                      │
 * │  Not "should not". The whole design of Phase 6 rests on this file    │
 * │  being incapable of reaching `history`, so that when Phase 9 starts  │
 * │  feeding it a hundred ops a second from four other people, undo      │
 * │  cannot possibly revert their work.                                  │
 * │                                                                      │
 * │  A unit test reads this file's source and fails the build if an      │
 * │  import of ./history or ./HistoryManager ever appears in it.         │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * It is a separate module rather than a second function in `apply.ts` for
 * exactly that reason: a rule you can check by reading one short file is a
 * rule that survives contact with a rushed pull request.
 *
 * Phase 9 adds the parts that belong to the sync engine and not to the
 * document: sequence ordering, gap buffering, and Zod validation at the
 * socket boundary (R-SYNC-020, R-SEC-003). Those all sit UPSTREAM of this
 * call; by the time ops arrive here they are in order and already validated.
 */
export function applyRemoteOp(ops: readonly ClientOp[]): void {
  if (ops.length === 0) return
  boardStore.getState().applyOps(ops)
}
