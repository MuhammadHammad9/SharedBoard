import {
  GAP_FILL_DEBOUNCE_MS,
  type ClientOp,
  type ConnectionState,
  type Role,
  type ServerMessage,
  type ServerOp,
} from '@coboard/shared'
import { getBoardState, getOpsSince } from '../boards/api.js'
import { applyRemoteOp } from '../canvas/history/applyRemote.js'
import { boardStore } from '../../stores/boardStore.js'
import { activeSession } from './persistence.js'
import { syncEvent } from './probe.js'

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
  fetchSnapshot?: typeof getBoardState
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
  /**
   * MY ops the server has ordered, keyed by their seq → op id. The server
   * never broadcasts an op back to its author, so without these the author's
   * own seqs would be permanent holes: `lastAppliedSeq` would stall at every
   * one of them and only a REST gap fill could move it on.
   */
  private readonly own = new Map<number, string>()
  /** Ops that arrived before the snapshot did — the load-ordering rule. */
  private buffered: ServerOp[] = []
  private snapshotLoaded = false

  private gapTimer: unknown = null
  private gapFilling = false
  private unknownObjectTimes: number[] = []
  private reloadRequested = false
  /** An E-13 snapshot reload is in flight: incoming ops wait, unapplied. */
  private reloading = false

  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly fetchOpsSince: typeof getOpsSince
  private readonly fetchSnapshot: typeof getBoardState

  constructor(
    private readonly boardId: string,
    private readonly callbacks: SyncCallbacks,
    private readonly deps: SyncDeps,
  ) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? (h => globalThis.clearTimeout(h as number))
    this.fetchOpsSince = deps.fetchOpsSince ?? getOpsSince
    this.fetchSnapshot = deps.fetchSnapshot ?? getBoardState
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
        /*
         * The outbox owns nacks, through the socket transport's `settle`: it
         * rolls the change back, drops the undo entry and reports once per
         * batch. Reporting here as well toasted every refusal twice.
         */
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

    // Mid-reload, the document is about to be replaced: hold everything and
    // drain on top of the fresh snapshot instead.
    if (this.reloading) return
    this.drain()
  }

  /**
   * One of MY ops was ordered at `seq` — its ack, or its echo in a catch-up.
   *
   * ┌──────────────────────────────────────────────────────────────────────┐
   * │  The fields it wrote are released when the DOCUMENT reaches `seq`,   │
   * │  not when the ack arrives.                                           │
   * │                                                                      │
   * │  The server acks at once and batches broadcasts for 16 ms, so my ack │
   * │  for seq 10 routinely lands before a teammate's seq 9. Released at   │
   * │  the ack, their older write would then be applied over my newer one │
   * │  — here and nowhere else. Released in order, seq 9 arrives while the │
   * │  field is still held, and the document is right.                     │
   * └──────────────────────────────────────────────────────────────────────┘
   */
  markOwn(seq: number, opId: string): void {
    if (this.reloading) {
      this.own.set(seq, opId)
      return
    }
    if (!this.snapshotLoaded || seq <= this.lastAppliedSeq) {
      // Already passed — it was applied in order as part of a replay.
      activeSession()?.release(opId)
      return
    }
    this.own.set(seq, opId)
    this.drain()
  }

  private drain(): void {
    /*
     * In seq order, each remote op is applied and each of my own releases its
     * fields AT ITS POSITION. Remote ops between two of mine are applied as
     * one batch, so a long catch-up is still one store commit per run.
     */
    let batch: ServerOp[] = []
    const flush = () => {
      if (batch.length > 0) this.apply(batch)
      batch = []
    }
    for (;;) {
      const next = this.lastAppliedSeq + 1
      const remote = this.pending.get(next)
      if (remote) {
        this.pending.delete(next)
        // My own op, echoed by a replay. The reconcile step releases it.
        this.own.delete(next)
        batch.push(remote)
        this.lastAppliedSeq = next
        continue
      }
      const mine = this.own.get(next)
      if (mine !== undefined) {
        this.own.delete(next)
        flush()
        this.lastAppliedSeq = next
        activeSession()?.release(mine)
        continue
      }
      break
    }
    flush()

    /*
     * Anything still pending means a hole. Debounced, because out-of-order
     * delivery inside one batch is common and self-healing — asking the server
     * to re-send on every reordered pair would be a request per frame.
     */
    if (this.pending.size > 0 || this.own.size > 0) this.scheduleGapFill()
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
    const { objects, tombstones } = boardStore.getState()
    for (const op of ops) {
      if (op.type === 'CREATE') continue
      if (objects.has(op.objectId as never)) continue
      /*
       * A DELETED object is not unknown. An update to something a teammate
       * deleted a moment ago is the ordinary losing side of delete-wins
       * (R-CONV-003), and counting it reloaded busy boards every few seconds.
       */
      if (tombstones.has(op.objectId as never)) continue
      syncEvent(`unknown-object #${op.seq} ${op.type} ${op.objectId.slice(0, 8)}`)
      this.noteUnknownObject()
    }

    /*
     * Fields this client is still waiting on are held back, and our own ops
     * echoed by a catch-up count as acks — see pendingWrites.ts. Without this
     * a remote write ordered BEFORE an unacked local one overwrites it here
     * and nowhere else: a permanent divergence (R-CONV-001).
     */
    const reconciled = activeSession()?.reconcileRemote(ops) ?? ops

    // The REMOTE path. It cannot reach the history stack — that separation is
    // what keeps undo per-user (R-UNDO-001), and it is enforced by a test that
    // reads applyRemote.ts's source.
    applyRemoteOp(reconciled as unknown as ClientOp[])
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

  /**
   * A fresh snapshot — the E-13 escape hatch (FLOWS §12.5).
   *
   * ┌──────────────────────────────────────────────────────────────────────┐
   * │  Three things the first version got wrong, each a divergence:       │
   * │                                                                      │
   * │  • It replayed the op log from 0 — one page of it — rather than     │
   * │    loading a snapshot, so a long board came back truncated.         │
   * │  • It wiped the document, losing this user's own unacknowledged     │
   * │    edits: still queued for the server, gone from their screen.      │
   * │  • It cleared the gap buffer, dropping ops that arrived during the  │
   * │    fetch; with nothing written afterwards the hole was never seen.  │
   * │                                                                      │
   * │  Now incoming ops and own acks are held while the fetch is in       │
   * │  flight, the snapshot replaces the document, everything it already  │
   * │  covers is discarded, my unacked edits go back on top, and the held │
   * │  ops drain after it.                                                │
   * └──────────────────────────────────────────────────────────────────────┘
   */
  private async reloadFromServer(): Promise<void> {
    this.reloading = true
    syncEvent(`snapshot-reload from seq ${this.lastAppliedSeq}`)
    try {
      const state = await this.fetchSnapshot(this.boardId)
      boardStore.getState().loadObjects(state.objects)
      this.lastAppliedSeq = state.seq
      for (const seq of [...this.pending.keys()])
        if (seq <= state.seq) this.pending.delete(seq)
      const session = activeSession()
      for (const [seq, id] of [...this.own]) {
        if (seq > state.seq) continue
        this.own.delete(seq)
        session?.release(id)
      }
      session?.reapplyUnacked(state.seq)
    } catch {
      // Nothing better to try. The next reconnect re-joins with our seq.
    } finally {
      this.reloading = false
      this.reloadRequested = false
    }
    this.drain()
  }

  private releaseAllOwn(): void {
    const session = activeSession()
    for (const id of this.own.values()) session?.release(id)
    this.own.clear()
  }

  dispose(): void {
    this.cancelGapFill()
    this.pending.clear()
    this.own.clear()
    this.buffered = []
  }
}
