import { ApiError, NETWORK_ERROR_CODE } from '../../lib/api.js'
import { appendOps } from '../boards/api.js'
import { clearOutbox, Outbox, type OutboxStatus } from './Outbox.js'
import { PendingWrites } from './pendingWrites.js'
import { syncEvent } from './probe.js'
import { invertOp } from '../canvas/history/inverseOps.js'
import { boardStore } from '../../stores/boardStore.js'
import type { ClientOp, ObjectId, ServerMessage, ServerOp } from '@coboard/shared'
import { track } from '../../lib/analytics.js'

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
  /**
   * Ops the server refused, AFTER the board has been put back — E-16. The
   * caller tells the user; it does not need to undo anything.
   */
  onNack?: (ops: readonly ClientOp[]) => void
  /** Drop the undo entries holding refused ops — CLAUDE.md §3.2 6b. */
  discardHistory?: (opIds: ReadonlySet<string>) => void
  onStatus?: (status: OutboxStatus, pending: number) => void
  onPending?: (pending: number) => void
  /**
   * My op was ordered at `seq`. The sync engine releases its held fields when
   * the document reaches that seq (`SyncEngine.markOwn`). Absent — no live
   * engine — they are released at once.
   */
  onOrdered?: (opId: string, seq: number) => void
  /**
   * The seq of the snapshot this page loaded. Ops restored from storage that
   * the server turns out to have stored at or below it are already in the
   * document — see `settle`.
   */
  loadSeq?: number
}

export class PersistenceSession {
  readonly outbox: Outbox
  /** Unacked local writes — R-CONV-001. See pendingWrites.ts. */
  readonly pending = new PendingWrites()
  /**
   * The seq of the document this page last LOADED wholesale — the first
   * snapshot, or an E-13 reload. A tracked op acked at or below it was
   * already in that document.
   */
  private loadSeq: number

  /** Set by the board once the socket is live. Null means REST-only. */
  private socket: SocketTransportBinding | null = null

  constructor(
    readonly boardId: string,
    private readonly callbacks: SessionCallbacks = {},
  ) {
    this.loadSeq = callbacks.loadSeq ?? 0
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
      onAck: (ids, seqs) => {
        ids.forEach((id, i) => this.settle(id, seqs?.[i]))
      },
      onNack: (ops, reasons) => this.onNacked(ops, reasons),
      // Never sent, so never ordered: the document goes back to what the
      // server has, and the fields they held are released.
      onDrop: ops => {
        syncEvent(`drop ${ops.length}`)
        applyLocal(ops.flatMap(op => this.pending.revert(op.id)))
      },
      ...(callbacks.onStatus ? { onStatus: callbacks.onStatus } : {}),
      ...(callbacks.onPending ? { onPending: callbacks.onPending } : {}),
    })
    this.adoptRestored()
  }

  /**
   * Ops left in storage by a previous page — the "close the tab offline,
   * come back" path (FR-RT-012).
   *
   * They are replayed to the server, and the server leaves the sender out of
   * the broadcast, so unless they are applied HERE the user's own offline
   * work stays invisible until some later reload. Applied through the plain
   * store path: no history (this page did not make them, R-UNDO-006) and no
   * emit (they are already queued).
   *
   * A CREATE whose object the snapshot already has, or a DELETE whose object
   * it lacks, was evidently stored before the disconnect. Re-applying the
   * CREATE would overwrite later edits with the original payload, so both are
   * left to the outbox's harmless re-send and not touched locally.
   */
  private adoptRestored(): void {
    const restored = this.outbox.snapshot()
    if (restored.length === 0) return
    const store = boardStore.getState()
    const read = (id: ObjectId) => boardStore.getState().objects.get(id)

    for (const op of restored) {
      const exists = store.objects.has(op.objectId as ObjectId)
      if (op.type === 'CREATE' && exists) continue
      if (op.type !== 'CREATE' && !exists) continue
      const inverse = invertOp(op, read)
      boardStore.getState().applyOps([op])
      this.pending.track([op], inverse ? [inverse] : null, true)
    }
  }

  /**
   * The server has my op at `seq` — from its ack, or because it came back to
   * me in a catch-up replay.
   */
  private settle(opId: string, seq: number | undefined): void {
    const op = this.pending.typeOf(opId)
    if (!op) return

    /*
     * Restored after a reload, and stored before the snapshot this page
     * loaded. The snapshot already reflects it AND everything ordered after
     * it, so our re-application was stale: put the document back to what
     * the server says.
     */
    if (this.pending.isRestored(opId) && seq !== undefined && seq <= this.loadSeq) {
      syncEvent(`restored-stale ${opId.slice(0, 8)} seq ${seq}`)
      applyLocal(this.pending.revert(opId))
      return
    }

    if (op.type === 'DELETE' && seq !== undefined) {
      boardStore.getState().confirmDelete(op.objectId as ObjectId, seq)
    }
    if (seq !== undefined && this.callbacks.onOrdered) {
      this.callbacks.onOrdered(opId, seq)
      return
    }
    this.pending.ack(opId)
  }

  /**
   * The document was just replaced by a snapshot (E-13). Put my unacked
   * edits back on top — they are still on their way to the server, and the
   * snapshot does not have them yet.
   */
  reapplyUnacked(snapshotSeq: number): void {
    syncEvent(`reapply-unacked at ${snapshotSeq}, ${this.pending.size} tracked`)
    const store = boardStore.getState()
    this.pending.rebase(
      id => store.objects.get(id as ObjectId) as Record<string, unknown> | undefined,
    )
    /*
     * EVERY op still tracked, not only those still queued: an op acked while
     * the snapshot was in flight has left the outbox but may be newer than
     * the snapshot, and dropping it here erased the user's own edit for good.
     *
     * Some of these may be OLDER than the snapshot — stored, ack in flight.
     * They are marked like ops restored after a reload, so that an ack at or
     * below `snapshotSeq` puts the snapshot's value back (see `settle`).
     */
    this.loadSeq = snapshotSeq
    const ops = this.pending.tracked()
    this.pending.markRestored(ops.map(op => op.id))
    applyLocal(ops)
  }

  /** The document has reached this op's seq. Its fields stop being held. */
  release(opId: string): void {
    this.pending.ack(opId)
  }

  /**
   * The server refused these — R-SYNC-011. Never retried. The board goes back
   * to the confirmed state and the undo entries go with it.
   */
  private onNacked(
    ops: readonly ClientOp[],
    reasons: Readonly<Record<string, string>> = {},
  ): void {
    syncEvent(`nack ${ops.map(o => `${o.type} ${o.id.slice(0, 8)}`).join(', ')}`)
    // PRD §9 — one event per refused op, including those refused while
    // SYNCING that the board does not toast about: the metric is refusals,
    // not refusals the user was told of.
    for (const op of ops) {
      track('op_rejected', { op_type: op.type, reason: reasons[op.id] ?? 'UNKNOWN' })
    }
    applyLocal(ops.flatMap(op => this.pending.revert(op.id)))
    this.callbacks.discardHistory?.(new Set(ops.map(op => op.id)))
    this.callbacks.onNack?.(ops)
  }

  /**
   * Remote ops on their way into the document — R-CONV-001.
   *
   * Two things happen here, in seq order, op by op:
   *   • An op that is one of MINE came back in a catch-up replay: it was
   *     stored before an ack could reach us. That is an ack — and it is not
   *     applied again, because it already is.
   *   • Anything else has the fields I am still waiting on held back.
   */
  reconcileRemote(ops: readonly ServerOp[]): ServerOp[] {
    if (this.pending.size === 0) return ops as ServerOp[]
    const out: ServerOp[] = []
    for (const op of ops) {
      if (this.pending.has(op.id)) {
        this.settle(op.id, op.seq)
        continue
      }
      const kept = this.pending.filterRemote(op as unknown as ClientOp)
      if (kept) out.push(kept as unknown as ServerOp)
    }
    return out
  }

  /** Hand the session a live socket. Called after `join_ack`. */
  bindSocket(binding: SocketTransportBinding | null): void {
    this.socket = binding
    if (binding) this.outbox.resume()
  }

  emit(ops: readonly ClientOp[], inverse: readonly ClientOp[] | null = null): void {
    this.pending.track(ops, inverse)
    this.outbox.enqueue(ops)
  }

  /** Coming back online — flush immediately rather than waiting out a backoff. */
  resume(): void {
    this.outbox.resume()
  }

  close(): void {
    this.outbox.close()
    this.pending.clear()
  }
}

/** The local path with no history and no emit — rollback and adoption only. */
function applyLocal(ops: readonly ClientOp[]): void {
  if (ops.length > 0) boardStore.getState().applyOps(ops)
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
        acked: applied.map(a => a.id),
        seqs: applied.map(a => a.seq),
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
      if (
        error.code === NETWORK_ERROR_CODE ||
        error.status >= 500 ||
        error.status === 0
      ) {
        throw error
      }
      // 429 is retryable too — the server is asking us to wait, not refusing.
      if (error.status === 429) throw error

      // Everything else — 403 view-only, 404 board gone, 422 invalid — is a
      // decision. Nack the whole batch.
      const reason = error.code || `HTTP_${error.status}`
      return {
        acked: [],
        nacked: ops.map(op => op.id),
        reasons: Object.fromEntries(ops.map(op => [op.id, reason])),
      }
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
export function emitOps(
  ops: readonly ClientOp[],
  inverse: readonly ClientOp[] | null = null,
): void {
  session?.emit(ops, inverse)
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
  send: (ops: readonly ClientOp[]) => Promise<{
    acked: string[]
    nacked: string[]
    seqs: Array<number | undefined>
    reasons: Record<string, string>
  }>
  /** Route an incoming ack/nack into the pending batches. */
  settle: (message: ServerMessage) => void
  /**
   * The socket is gone. Every batch still waiting on it fails NOW rather than
   * at its ack timeout, so the outbox keeps those ops — at the front of its
   * queue, where they already are — and replays them on the next connection
   * instead of sitting out ten seconds first.
   */
  abort: () => void
}

export function createSocketTransport(
  send: (message: { t: 'op_batch'; ops: ClientOp[] }) => boolean,
  isOpen: () => boolean,
  timeoutMs = SOCKET_ACK_TIMEOUT_MS,
): SocketTransportBinding {
  interface Waiting {
    remaining: Set<string>
    acked: string[]
    seqs: Array<number | undefined>
    nacked: string[]
    reasons: Record<string, string>
    resolve: (value: {
      acked: string[]
      nacked: string[]
      seqs: Array<number | undefined>
      reasons: Record<string, string>
    }) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }

  const waiting: Waiting[] = []

  const finish = (batch: Waiting) => {
    clearTimeout(batch.timer)
    const index = waiting.indexOf(batch)
    if (index >= 0) waiting.splice(index, 1)
    batch.resolve({
      acked: batch.acked,
      nacked: batch.nacked,
      seqs: batch.seqs,
      reasons: batch.reasons,
    })
  }

  const record = (
    id: string,
    kind: 'acked' | 'nacked',
    seq?: number,
    reason?: string,
  ) => {
    const batch = waiting.find(w => w.remaining.has(id))
    if (!batch) return
    batch.remaining.delete(id)
    batch[kind].push(id)
    if (kind === 'acked') batch.seqs.push(seq)
    if (reason !== undefined) batch.reasons[id] = reason
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
          seqs: [],
          nacked: [],
          reasons: {},
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

    abort: () => {
      for (const batch of waiting.splice(0)) {
        clearTimeout(batch.timer)
        batch.reject(new Error('socket closed'))
      }
    },

    settle: message => {
      if (message.t === 'ack') {
        message.ids.forEach((id, i) => record(id, 'acked', message.seqs[i]))
      } else if (message.t === 'nack') {
        record(message.id, 'nacked', undefined, message.code)
      }
    },
  }
}
