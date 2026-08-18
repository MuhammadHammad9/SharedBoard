import { ApiError, NETWORK_ERROR_CODE } from '../../lib/api.js'
import { appendOps } from '../boards/api.js'
import { clearOutbox, Outbox, type OutboxStatus } from './Outbox.js'
import type { ClientOp } from '@coboard/shared'

/**
 * The bridge between the local write path and the server — Phase 8's half of
 * FR-SYNC-004/005.
 *
 * `applyAndEmit` calls `emitOps` for every local change without knowing
 * whether a board is open, whether there is a network, or what the transport
 * is. When no session is active — the Phase 2-6 canvas e2e suites open a board
 * id that is not a real board — ops are simply dropped, and the canvas works
 * exactly as it did before.
 *
 * Phase 9 replaces `restTransport` with the socket. Nothing else here moves:
 * the queue, the persistence, the nack rollback and the status reporting are
 * transport-agnostic by construction.
 */

let session: PersistenceSession | null = null

export interface SessionCallbacks {
  /** Ops the server refused. The board rolls them back and toasts — E-16. */
  onNack?: (ops: readonly ClientOp[]) => void
  onStatus?: (status: OutboxStatus, pending: number) => void
}

export class PersistenceSession {
  readonly outbox: Outbox

  constructor(
    readonly boardId: string,
    callbacks: SessionCallbacks = {},
  ) {
    this.outbox = new Outbox({
      boardId,
      send: restTransport(boardId),
      ...(callbacks.onNack ? { onNack: callbacks.onNack } : {}),
      ...(callbacks.onStatus ? { onStatus: callbacks.onStatus } : {}),
    })
  }

  emit(ops: readonly ClientOp[]): void {
    this.outbox.enqueue(ops)
  }

  /** Coming back online — flush immediately rather than waiting out a backoff. */
  resume(): void {
    this.outbox.resume()
  }

  close(): void {
    this.outbox.close()
  }
}

/**
 * POST a batch and classify the outcome.
 *
 * The classification is the substance. Three outcomes, and conflating any two
 * of them breaks something:
 *
 *   network failure / 5xx  → REJECT, so the batch is retried (R-SYNC-030)
 *   4xx that is a decision → nack, so the op is rolled back and NOT retried
 *                            (R-SYNC-011 — retrying a rejection loops forever)
 *   200                    → acked, including the server's re-acks of ops it
 *                            had already stored (R-SYNC-014)
 */
function restTransport(boardId: string) {
  return async (ops: readonly ClientOp[]) => {
    try {
      const { applied } = await appendOps(boardId, ops)
      const acked = new Set(applied.map(a => a.id))
      return {
        acked: [...acked],
        /*
         * An op the server answered 200 to but did not list is a case that
         * should not happen. Treating it as nacked rather than silently
         * dropping it keeps the queue from stalling on it forever, and the
         * rollback makes the discrepancy visible instead of leaving a local
         * object no server has.
         */
        nacked: ops.filter(op => !acked.has(op.id)).map(op => op.id),
      }
    } catch (error) {
      if (!(error instanceof ApiError)) throw error

      // Retryable: no network, or the server had a bad moment.
      if (error.code === NETWORK_ERROR_CODE || error.status >= 500 || error.status === 0) {
        throw error
      }
      // 429 is retryable too — the server is asking us to wait, not refusing.
      if (error.status === 429) throw error

      // Everything else — 403 view-only, 404 board gone, 422 invalid — is a
      // decision. Nack the whole batch.
      return { acked: [], nacked: ops.map(op => op.id) }
    }
  }
}

/* ── The module-level seam ─────────────────────────────────────────────────── */

/**
 * Flush as soon as the connection returns, rather than waiting out a backoff.
 *
 * Registered once per session and removed on stop. Without it a user who
 * reconnects after 30 seconds offline waits up to another 30 for the retry
 * timer to fire, which reads as "my work did not save" even though it is
 * queued and safe.
 */
let onOnline: (() => void) | null = null

export function startPersistence(
  boardId: string,
  callbacks: SessionCallbacks = {},
): PersistenceSession {
  stopPersistence()
  session = new PersistenceSession(boardId, callbacks)

  onOnline = () => session?.resume()
  globalThis.addEventListener?.('online', onOnline)

  // Anything left from a previous visit goes out immediately — this is the
  // "lose wifi, close the tab, come back, nothing lost" path.
  session.resume()
  return session
}

export function stopPersistence(): void {
  if (onOnline) {
    globalThis.removeEventListener?.('online', onOnline)
    onOnline = null
  }
  session?.close()
  session = null
}

/** Discards a board's queued work. Used when the board no longer exists. */
export function abandonPersistence(boardId: string): void {
  stopPersistence()
  clearOutbox(boardId)
}

export const activeSession = (): PersistenceSession | null => session

/**
 * Called by `applyAndEmit` for every local change.
 *
 * A no-op with no session, by design. The canvas must not require a server to
 * work — that is what makes offline drawing instant and what lets the Phase
 * 2-6 suites run without a database.
 */
export function emitOps(ops: readonly ClientOp[]): void {
  session?.emit(ops)
}
