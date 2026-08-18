import type { ClientOp } from '@coboard/shared'

/**
 * The outbox — TRD §5.5, FR-SYNC-004/005, R-SYNC-010.
 *
 * Every op the user commits goes in here before it goes anywhere else, and it
 * leaves only when the server has acknowledged it. That is the whole of the
 * zero-loss guarantee: if the tab is closed, the wifi drops or the server
 * restarts, the ops that never got an ack are still on disk and are re-sent on
 * the next connection.
 *
 * Two properties make the replay safe rather than merely optimistic:
 *
 *   1. Every op carries a CLIENT-generated id which the server uses as its
 *      primary key (R-SYNC-014). Re-sending an op the server already stored is
 *      a re-ack, not a duplicate — so "did my request arrive?" stops being a
 *      question anyone has to answer.
 *   2. Ops are immutable. Nothing here rewrites a queued op, so replay
 *      reproduces exactly what the user did.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  Phase 8 sends over REST. Phase 9 swaps the transport for the socket.    │
 * │                                                                          │
 * │  That is why `send` is injected rather than imported: the queueing, the  │
 * │  persistence, the ack accounting and the backoff are all transport-      │
 * │  agnostic and are written once. Phase 9 changes one function.            │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

const KEY_PREFIX = 'coboard.outbox.'

/** Above this, the queue is trimmed from the FRONT — see `enqueue`. */
export const OUTBOX_MAX = 5_000

export type OutboxStatus = 'idle' | 'sending' | 'retrying' | 'offline'

export interface OutboxTransport {
  /**
   * Deliver a batch. Resolve to the ids the server accepted (or re-acked).
   *
   * Reject to signal a TRANSPORT failure — the batch stays queued and is
   * retried. Resolving with a subset means the server made a decision about
   * the rest, and a decision is not a network error: those ops are dropped
   * from the queue and reported through `onNack` (R-SYNC-011).
   */
  (ops: readonly ClientOp[]): Promise<{ acked: string[]; nacked: string[] }>
}

export interface OutboxOptions {
  boardId: string
  send: OutboxTransport
  /** Ops the server refused. The caller rolls them back locally. */
  onNack?: (ops: readonly ClientOp[]) => void
  onStatus?: (status: OutboxStatus, pending: number) => void
  /** Injected in tests so backoff does not make the suite wait. */
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** Batch size per request. Matches the server's `ops` array cap. */
const BATCH = 100

/**
 * Full-jitter backoff — R-SYNC-030.
 *
 * `random() * ceiling`, not `ceiling`. A server that restarts with 200 clients
 * attached gets 200 retries spread across the window instead of 200 arriving
 * in the same millisecond, killing it again. Without the jitter the reconnect
 * storm is self-sustaining.
 */
const BACKOFF_CEILING_MS = 30_000
const backoffFor = (attempt: number): number =>
  Math.random() * Math.min(BACKOFF_CEILING_MS, 500 * 2 ** Math.min(attempt, 6))

export class Outbox {
  private queue: ClientOp[] = []
  private inFlight = false
  private attempt = 0
  private timer: unknown = null
  private status: OutboxStatus = 'idle'
  private closed = false

  private readonly key: string
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly options: OutboxOptions) {
    this.key = `${KEY_PREFIX}${options.boardId}`
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? (h => globalThis.clearTimeout(h as number))
    this.queue = this.restore()
  }

  get pending(): number {
    return this.queue.length
  }

  /** A copy, for tests and the debug overlay. Never the live array. */
  snapshot(): ClientOp[] {
    return [...this.queue]
  }

  /**
   * Queue ops and start a flush.
   *
   * Persisted synchronously, BEFORE the send is attempted. Writing after the
   * response would leave a window in which an op exists only in flight, and
   * that window is precisely when a tab gets closed.
   */
  enqueue(ops: readonly ClientOp[]): void {
    if (ops.length === 0 || this.closed) return
    this.queue.push(...ops)

    /*
     * A queue this long means the user has been offline for a very long time.
     * Trimming from the FRONT keeps the most recent work, which is what they
     * will look for when they come back — and the alternative, refusing new
     * ops, would break drawing while offline, which is the one thing the
     * offline path exists to protect.
     */
    if (this.queue.length > OUTBOX_MAX) {
      this.queue = this.queue.slice(this.queue.length - OUTBOX_MAX)
    }

    this.persist()
    void this.flush()
  }

  /**
   * Send until the queue is empty or something fails.
   *
   * Re-entrant calls are collapsed: `inFlight` means a flush is already
   * walking the queue, and a second walker would send the same batch twice.
   */
  async flush(): Promise<void> {
    if (this.inFlight || this.closed || this.queue.length === 0) return
    if (!this.online()) {
      this.setStatus('offline')
      return
    }

    this.inFlight = true
    this.setStatus('sending')

    try {
      while (this.queue.length > 0 && !this.closed) {
        const batch = this.queue.slice(0, BATCH)
        const { acked, nacked } = await this.options.send(batch)

        const settled = new Set([...acked, ...nacked])
        const refused = batch.filter(op => nacked.includes(op.id))

        /*
         * Remove settled ops by id rather than by splicing off the front.
         * `enqueue` can have appended while the request was in flight, and
         * splicing a fixed count would drop ops that were never sent.
         */
        this.queue = this.queue.filter(op => !settled.has(op.id))
        this.persist()

        // A nack is a DECISION, not a network error, so it is never retried —
        // R-SYNC-011. The caller undoes it locally and tells the user.
        if (refused.length > 0) this.options.onNack?.(refused)

        // Neither acked nor nacked: the server answered without settling
        // anything. Treat it as a failure rather than looping forever.
        if (settled.size === 0) throw new Error('outbox: batch settled nothing')

        this.attempt = 0
      }
      this.setStatus('idle')
    } catch {
      this.attempt += 1
      this.setStatus('retrying')
      this.scheduleRetry()
    } finally {
      this.inFlight = false
    }
  }

  private scheduleRetry(): void {
    if (this.closed || this.timer !== null) return
    this.timer = this.setTimer(() => {
      this.timer = null
      void this.flush()
    }, backoffFor(this.attempt))
  }

  /** Called when the browser comes back online, and on reconnect in Phase 9. */
  resume(): void {
    this.attempt = 0
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    void this.flush()
  }

  close(): void {
    this.closed = true
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
    }
    // The queue stays on disk on purpose. Unacked work is exactly what the
    // next session has to replay.
    this.persist()
  }

  private online(): boolean {
    const nav = globalThis.navigator as { onLine?: boolean } | undefined
    // `undefined` means we cannot tell, and assuming offline would stop a
    // perfectly working client from ever sending.
    return nav?.onLine !== false
  }

  private setStatus(status: OutboxStatus): void {
    if (status === this.status) return
    this.status = status
    this.options.onStatus?.(status, this.queue.length)
  }

  /* ── Persistence ────────────────────────────────────────────────────────── */

  private persist(): void {
    try {
      if (this.queue.length === 0) {
        globalThis.localStorage?.removeItem(this.key)
        return
      }
      globalThis.localStorage?.setItem(
        this.key,
        JSON.stringify({ v: 1, at: this.now(), ops: this.queue }),
      )
    } catch {
      /*
       * Quota, private mode, or storage disabled. Swallowed deliberately: the
       * in-memory queue still works, so this session loses nothing. The only
       * casualty is survival across a reload, and breaking drawing to complain
       * about it would be a worse trade.
       */
    }
  }

  /**
   * Read the queue back, validating it.
   *
   * `localStorage` is user-writable, so this is untrusted input on the way to
   * the server (R-SEC-003 in spirit — the server validates it again, and this
   * is what stops a hand-edited blob from being replayed forever because it is
   * rejected on every attempt).
   */
  private restore(): ClientOp[] {
    try {
      const raw = globalThis.localStorage?.getItem(this.key)
      if (!raw) return []
      const parsed = JSON.parse(raw) as { v?: number; ops?: unknown }
      if (parsed.v !== 1 || !Array.isArray(parsed.ops)) return []
      return parsed.ops.filter(isPlausibleOp).slice(-OUTBOX_MAX)
    } catch {
      return []
    }
  }
}

/**
 * A cheap shape check, not a schema parse.
 *
 * The server validates properly with Zod, and it has to — it cannot trust this
 * client at all. Running the full `ClientOpSchema` over a 5,000-op queue on
 * every board open would cost more than it saves; the point here is only to
 * discard obvious junk so the queue does not contain items that can never be
 * sent.
 */
function isPlausibleOp(value: unknown): value is ClientOp {
  if (typeof value !== 'object' || value === null) return false
  const op = value as Partial<ClientOp>
  return (
    typeof op.id === 'string' &&
    typeof op.objectId === 'string' &&
    (op.type === 'CREATE' || op.type === 'UPDATE' || op.type === 'DELETE') &&
    typeof op.payload === 'object' &&
    op.payload !== null
  )
}

/** Discard a board's persisted queue — used when the board is gone. */
export function clearOutbox(boardId: string): void {
  try {
    globalThis.localStorage?.removeItem(`${KEY_PREFIX}${boardId}`)
  } catch {
    /* see persist() */
  }
}
