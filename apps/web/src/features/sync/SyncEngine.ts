import {
  GAP_FILL_DEBOUNCE_MS,
  type ClientOp,
  type ConnectionState,
  type Role,
  type ServerMessage,
  type ServerOp,
} from '@coboard/shared'
import { getOpsSince } from '../boards/api.js'
import { applyRemoteOp } from '../canvas/history/applyRemote.js'
import { boardStore } from '../../stores/boardStore.js'

/**
 * Ordering, gaps and the document — TRD §6.3, FLOWS §2.3 STEP 5.
 *
 * `SocketClient` keeps a connection alive and hands over validated messages.
 * This decides what they mean. Three responsibilities, and each is a bug class
 * if it lives anywhere else:
 *
 *  1. ORDER. Ops apply in seq order or not at all (R-SYNC-020). A batch that
 *     arrives with a hole is buffered, not applied — applying op 43 before 42
 *     means an UPDATE can land on an object its CREATE has not made yet.
 *  2. THE LOAD RULE. The snapshot and the socket race deliberately, and ops
 *     arriving before the snapshot lands are BUFFERED (R-SYNC-035). Skipping
 *     this is the classic "objects flicker in and then vanish" bug.
 *  3. ACKS AND NACKS. An ack clears the outbox. A nack rolls the change back
 *     locally and is never retried (R-SYNC-011).
 */

export interface SyncCallbacks {
  onState: (state: ConnectionState) => void
  onRole: (role: Role) => void
  /** The server refused these ops. The board rolls them back and toasts. */
  onNack: (opIds: string[], code: string) => void
  /** The board is gone or access was revoked — S-18/S-19. */
  onFatal: (kind: 'deleted' | 'forbidden') => void
  onBoardRenamed?: (name: string) => void
}

export interface SyncDeps {
  send: (message: { t: 'join'; boardId: string; sinceSeq: number }) => boolean
  markSynced: () => void
  fetchOpsSince?: typeof getOpsSince
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** E-13: after this many unknown-object ops in a minute, reload the board. */
export const UNKNOWN_OBJECT_LIMIT = 3
const UNKNOWN_OBJECT_WINDOW_MS = 60_000

export class SyncEngine {
  /** The highest contiguous seq applied to the document. */
  private lastAppliedSeq = 0
  /** Ops that arrived ahead of their turn, keyed by seq. */
  private readonly pending = new Map<number, ServerOp>()
  /** Ops that arrived before the snapshot did — the load-ordering rule. */
  private buffered: ServerOp[] = []
  private snapshotLoaded = false

  private gapTimer: unknown = null
  private gapFilling = false
  private unknownObjectTimes: number[] = []
  private reloadRequested = false

  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly fetchOpsSince: typeof getOpsSince

  constructor(
    private readonly boardId: string,
    private readonly callbacks: SyncCallbacks,
    private readonly deps: SyncDeps,
  ) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? (h => globalThis.clearTimeout(h as number))
    this.fetchOpsSince = deps.fetchOpsSince ?? getOpsSince
  }

  get appliedSeq(): number {
    return this.lastAppliedSeq
  }

  get pendingCount(): number {
    return this.pending.size
  }

  /** Send `join`. Called on every (re)connect, including after a drop. */
  join(): void {
    this.deps.send({ t: 'join', boardId: this.boardId, sinceSeq: this.lastAppliedSeq })
  }

  /**
   * The snapshot landed — FLOWS §2.3 STEP 5.
   *
   * ┌──────────────────────────────────────────────────────────────────────┐
   * │  Apply the snapshot, then replay the buffer, then DROP whatever the  │
   * │  snapshot already contained.                                         │
   * │                                                                      │
   * │  Deviating in either direction breaks something visible. Apply the   │
   * │  buffer first and the snapshot overwrites live changes. Drop the     │
   * │  buffer entirely and everything drawn during the load is lost until  │
   * │  the next reload.                                                    │
   * └──────────────────────────────────────────────────────────────────────┘
   */
  snapshotReady(seq: number): void {
    if (this.snapshotLoaded) return
    this.snapshotLoaded = true
    this.lastAppliedSeq = seq

    const buffered = this.buffered
    this.buffered = []
    if (buffered.length > 0) this.receiveOps(buffered)
  }

  handle(message: ServerMessage): void {
    switch (message.t) {
      case 'join_ack':
        this.callbacks.onRole(message.role)
        this.deps.markSynced()
        /*
         * A join_ack whose seq is AHEAD of ours means we missed ops while
         * disconnected and the server's catch-up is on its way — or was too
         * large to send, in which case the gap fill below collects it.
         */
        if (this.snapshotLoaded && message.seq > this.lastAppliedSeq) {
          this.scheduleGapFill()
        }
        return

      case 'op_batch':
        this.receiveOps(message.ops)
        return

      case 'ack':
        // The outbox owns ack accounting; it is told through the transport's
        // own promise, not here. Nothing to do but note that we are live.
        return

      case 'nack':
        this.callbacks.onNack([message.id], message.code)
        return

      case 'board_deleted':
        this.callbacks.onFatal('deleted')
        return

      case 'access_revoked':
        this.callbacks.onFatal('forbidden')
        return

      case 'role_changed':
        this.callbacks.onRole(message.role)
        return

      case 'board_renamed':
        this.callbacks.onBoardRenamed?.(message.name)
        return

      // Presence — Phase 10.
      case 'presence_join':
      case 'presence_leave':
      case 'cursor':
      case 'sel':
      case 'stroke':
      case 'xform':
      case 'pong':
        return
    }
  }

  /**
   * Apply what can be applied, buffer what cannot — TRD §6.3.
   *
   * The drain is a `while`, not a `for`: filling a hole at seq 42 may release
   * 43, 44 and 45 that have been waiting, and they must all go in one pass or
   * the document sits behind until the next message happens to arrive.
   */
  receiveOps(ops: readonly ServerOp[]): void {
    // Before the snapshot, everything waits. This is the load-ordering rule.
    if (!this.snapshotLoaded) {
      this.buffered.push(...ops)
      return
    }

    for (const op of ops) {
      // Already applied. Re-delivery is normal after a reconnect and must be
      // free rather than an error (R-SYNC-021).
      if (op.seq <= this.lastAppliedSeq) continue
      this.pending.set(op.seq, op)
    }

    const ready: ServerOp[] = []
    while (this.pending.has(this.lastAppliedSeq + 1)) {
      const next = this.pending.get(this.lastAppliedSeq + 1)!
      this.pending.delete(next.seq)
      ready.push(next)
      this.lastAppliedSeq = next.seq
    }

    if (ready.length > 0) this.apply(ready)

    /*
     * Anything still pending means a hole. Debounced, because out-of-order
     * delivery inside one batch is common and self-healing — asking the server
     * to re-send on every reordered pair would be a request per frame.
     */
    if (this.pending.size > 0) this.scheduleGapFill()
    else this.cancelGapFill()
  }

  private apply(ops: ServerOp[]): void {
    /*
     * E-13: an op naming an object we have never seen.
     *
     * One is unremarkable — an UPDATE whose CREATE was in a batch we dropped
     * on a bad connection. Three in a minute means our document has genuinely
     * diverged, and the honest repair is a fresh snapshot rather than limping
     * on with a document that is quietly wrong.
     */
    const objects = boardStore.getState().objects
    for (const op of ops) {
      if (op.type === 'CREATE') continue
      if (objects.has(op.objectId as never)) continue
      this.noteUnknownObject()
    }

    // The REMOTE path. It cannot reach the history stack — that separation is
    // what keeps undo per-user (R-UNDO-001), and it is enforced by a test that
    // reads applyRemote.ts's source.
    applyRemoteOp(ops as unknown as ClientOp[])
  }

  private noteUnknownObject(): void {
    const now = Date.now()
    this.unknownObjectTimes = this.unknownObjectTimes.filter(
      t => now - t < UNKNOWN_OBJECT_WINDOW_MS,
    )
    this.unknownObjectTimes.push(now)
    if (this.unknownObjectTimes.length < UNKNOWN_OBJECT_LIMIT) return
    if (this.reloadRequested) return
    this.reloadRequested = true
    this.unknownObjectTimes = []
    void this.reloadFromServer()
  }

  private scheduleGapFill(): void {
    if (this.gapTimer !== null) return
    this.gapTimer = this.setTimer(() => {
      this.gapTimer = null
      void this.fillGap()
    }, GAP_FILL_DEBOUNCE_MS)
  }

  private cancelGapFill(): void {
    if (this.gapTimer === null) return
    this.clearTimer(this.gapTimer)
    this.gapTimer = null
  }

  /**
   * Ask the server for what we missed.
   *
   * Over REST, not the socket, and that is deliberate: the gap exists because
   * socket delivery failed, so asking the same channel to fix it is optimistic.
   * The REST endpoint is also the one that can page through a large backlog.
   */
  private async fillGap(): Promise<void> {
    if (this.gapFilling) return
    this.gapFilling = true
    try {
      const { ops } = await this.fetchOpsSince(this.boardId, this.lastAppliedSeq)
      if (ops.length > 0) this.receiveOps(ops as unknown as ServerOp[])
    } catch {
      // Still broken. The socket's own reconnect will re-join with our
      // sinceSeq, which asks for the same thing by another route.
    } finally {
      this.gapFilling = false
    }
  }

  /** A full reload — the E-13 escape hatch. */
  private async reloadFromServer(): Promise<void> {
    try {
      const { ops } = await this.fetchOpsSince(this.boardId, 0)
      this.pending.clear()
      this.lastAppliedSeq = 0
      boardStore.getState().loadObjects([])
      this.receiveOps(ops as unknown as ServerOp[])
    } catch {
      // Nothing better to try. The next reconnect re-joins from seq 0.
    } finally {
      this.reloadRequested = false
    }
  }

  dispose(): void {
    this.cancelGapFill()
    this.pending.clear()
    this.buffered = []
  }
}
