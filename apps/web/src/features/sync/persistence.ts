import { ApiError, NETWORK_ERROR_CODE } from '../../lib/api.js'
import { appendOps } from '../boards/api.js'
import { clearOutbox, Outbox, type OutboxStatus } from './Outbox.js'
import type { ClientOp, ServerMessage } from '@coboard/shared'

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
 * Phase 9 delivered on that: `socketTransport` is now the default and
 * `restTransport` is the fallback for when the socket is down. Nothing else
 * moved — the queue, the persistence, the nack rollback and the status
 * reporting never knew what the transport was.
 */

let session: PersistenceSession | null = null

export interface SessionCallbacks {
  /** Ops the server refused. The board rolls them back and toasts — E-16. */
  onNack?: (ops: readonly ClientOp[]) => void
  onStatus?: (status: OutboxStatus, pending: number) => void
}

export class PersistenceSession {
  readonly outbox: Outbox

  /** Set by the board once the socket is live. Null means REST-only. */
  private socket: SocketTransportBinding | null = null

  constructor(
    readonly boardId: string,
    callbacks: SessionCallbacks = {},
  ) {
    this.outbox = new Outbox({
      boardId,
      /*
       * ONE transport function that picks its route per batch.
       *
       * The socket when it is up, REST when it is not. The outbox does not
       * need to know, and giving it two transports to choose between would
       * put the connection state in the wrong module — the queue's job is
       * durability, not routing.
       */
      send: ops =>
        this.socket?.ready() ? this.socket.send(ops) : restTransport(this.boardId)(ops),
      ...(callbacks.onNack ? { onNack: callbacks.onNack } : {}),
      ...(callbacks.onStatus ? { onStatus: callbacks.onStatus } : {}),
    })
  }

  /** Hand the session a live socket. Called after `join_ack`. */
  bindSocket(binding: SocketTransportBinding | null): void {
    this.socket = binding
    if (binding) this.outbox.resume()
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


/* ── The socket transport ──────────────────────────────────────────────────── */

/**
 * A socket route for the outbox.
 *
 * The interesting part is that a socket has no request/response pairing: ops
 * go out as `op_batch` and the ack comes back as a separate message, possibly
 * batched with acks for other ops, possibly never. So this keeps a map of
 * in-flight op ids to their resolvers and settles them as acks and nacks
 * arrive — turning a message stream back into the promise the outbox expects.
 *
 * A batch that is never answered REJECTS on a timeout, which puts it back in
 * the queue for the outbox to retry. That is the correct outcome for a socket
 * that died mid-send: the alternative is a promise that never settles and an
 * outbox that never flushes again.
 */
export const SOCKET_ACK_TIMEOUT_MS = 10_000

export interface SocketTransportBinding {
  ready: () => boolean
  send: (ops: readonly ClientOp[]) => Promise<{ acked: string[]; nacked: string[] }>
  /** Route an incoming ack/nack into the pending batches. */
  settle: (message: ServerMessage) => void
}

export function createSocketTransport(
  send: (message: { t: 'op_batch'; ops: ClientOp[] }) => boolean,
  isOpen: () => boolean,
  timeoutMs = SOCKET_ACK_TIMEOUT_MS,
): SocketTransportBinding {
  interface Waiting {
    remaining: Set<string>
    acked: string[]
    nacked: string[]
    resolve: (value: { acked: string[]; nacked: string[] }) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }

  const waiting: Waiting[] = []

  const finish = (batch: Waiting) => {
    clearTimeout(batch.timer)
    const index = waiting.indexOf(batch)
    if (index >= 0) waiting.splice(index, 1)
    batch.resolve({ acked: batch.acked, nacked: batch.nacked })
  }

  const record = (id: string, kind: 'acked' | 'nacked') => {
    const batch = waiting.find(w => w.remaining.has(id))
    if (!batch) return
    batch.remaining.delete(id)
    batch[kind].push(id)
    if (batch.remaining.size === 0) finish(batch)
  }

  return {
    ready: isOpen,

    send: ops =>
      new Promise((resolve, reject) => {
        if (!send({ t: 'op_batch', ops: [...ops] })) {
          reject(new Error('socket send failed'))
          return
        }
        const batch: Waiting = {
          remaining: new Set(ops.map(op => op.id)),
          acked: [],
          nacked: [],
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = waiting.indexOf(batch)
            if (index >= 0) waiting.splice(index, 1)
            /*
             * Rejected, not resolved-with-nothing. A reject keeps the ops in
             * the outbox and schedules a retry; resolving with an empty result
             * would drop them, and the whole point of the outbox is that no
             * acknowledged-looking op is ever silently lost.
             */
            reject(new Error('socket ack timed out'))
          }, timeoutMs),
        }
        waiting.push(batch)
      }),

    settle: message => {
      if (message.t === 'ack') for (const id of message.ids) record(id, 'acked')
      else if (message.t === 'nack') record(message.id, 'nacked')
    },
  }
}
