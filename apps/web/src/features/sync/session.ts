import type { ConnectionState, Role, ServerMessage } from '@coboard/shared'
import { boardStore } from '../../stores/boardStore.js'
import { history } from '../canvas/history/history.js'
import { getBoardState } from '../boards/api.js'
import { SocketClient } from './SocketClient.js'
import { SyncEngine } from './SyncEngine.js'
import {
  createSocketTransport,
  startPersistence,
  stopPersistence,
  type PersistenceSession,
} from './persistence.js'
import { createPresenceEmitter } from '../presence/send.js'
import { presenceStore } from '../presence/presenceStore.js'
import { handlePresenceMessage } from '../presence/usePresence.js'
import { setPresenceEmitter } from '../presence/bus.js'
import { setSyncProbe } from './probe.js'
import { armFirstPaint } from '../canvas/renderer/firstPaint.js'

/**
 * The board session — FLOWS §2.3 STEP 5, the whole of it in one place.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  THE SNAPSHOT AND THE SOCKET RACE, ON PURPOSE.                           │
 * │                                                                          │
 * │    a. GET /boards/:id/snapshot  → { objects[], seq }                     │
 * │    b. open the socket and `join` with sinceSeq: 0                        │
 * │                                                                          │
 * │  Serialising them would add a full round trip to every board open. So    │
 * │  they run together, and ops arriving from (b) are BUFFERED until (a)     │
 * │  resolves — then the snapshot is applied, the buffer replayed, and       │
 * │  anything at or below the snapshot's seq dropped as already included.    │
 * │                                                                          │
 * │  Deviating from that order is the classic "objects flicker in and then   │
 * │  disappear" bug (R-SYNC-035): apply the buffer first and the snapshot    │
 * │  overwrites live work; drop the buffer and everything drawn during the   │
 * │  load is lost until the next reload.                                     │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * The buffering itself lives in `SyncEngine.snapshotReady`. This module owns
 * the wiring: who is constructed, in what order, and what is torn down.
 */

/**
 * How often stale presence is swept — R-PERF-023. An interval, never a second
 * rAF loop (R-CANVAS-010): once a second is plenty for a 60 s idle threshold.
 */
export const PRESENCE_SWEEP_EVERY_MS = 1_000

export interface BoardSessionCallbacks {
  onState: (state: ConnectionState) => void
  onRole: (role: Role) => void
  onNack: (opIds: string[], code: string) => void
  onFatal: (kind: 'deleted' | 'forbidden') => void
  onBoardRenamed?: (name: string) => void
  /** Reconnect attempt N is starting — "Reconnecting… (attempt {N})". */
  onAttempt?: (attempt: number) => void
  /** Unsent changes — "Syncing {N} changes…", and the offline banner. */
  onPending?: (pending: number) => void
  /** Reconnected and drained after a drop — "Back online — {N} changes synced". */
  onBackOnline?: (synced: number) => void
}

export interface BoardSessionResult {
  objects: number
  seq: number
  role: Role
  name: string
}

export class BoardSession {
  readonly socket: SocketClient
  readonly sync: SyncEngine
  private persistence: PersistenceSession | null = null
  private binding: ReturnType<typeof createSocketTransport> | null = null
  private disposed = false
  /**
   * The snapshot's seq, once it has been applied. Null until then: the outbox
   * must not start before the document exists (R-SYNC-035), because restored
   * ops are applied on top of it and a later `loadObjects` would wipe them.
   */
  private loadedSeq: number | null = null
  /** The most recent role the server reported, from join_ack or role_changed. */
  private latestRole: Role | null = null
  /** Set when the connection drops; read when it is whole again. */
  private droppedSince = false
  /** Unsent changes when SYNCING began, for the "back online" toast. */
  private syncingCount = 0
  private readonly detachWindow: () => void
  private readonly sweepTimer: ReturnType<typeof setInterval>

  constructor(
    readonly boardId: string,
    private readonly callbacks: BoardSessionCallbacks,
  ) {
    this.socket = new SocketClient(boardId, {
      // Every connect re-joins with our applied seq, so a reconnect replays
      // only the gap rather than reloading the board.
      onOpen: () => this.sync.join(),
      onMessage: message => this.onMessage(message),
      onState: state => this.onSocketState(state),
      onFatal: code => this.onFatalClose(code),
      onAttempt: attempt => this.callbacks.onAttempt?.(attempt),
      outboxSize: () => this.persistence?.outbox.pending ?? 0,
    })

    this.sync = new SyncEngine(
      boardId,
      {
        onState: callbacks.onState,
        onRole: role => this.onRole(role),
        onNack: callbacks.onNack,
        onFatal: callbacks.onFatal,
        ...(callbacks.onBoardRenamed ? { onBoardRenamed: callbacks.onBoardRenamed } : {}),
      },
      {
        send: message => this.socket.send(message),
        markSynced: () => this.onJoined(),
      },
    )

    this.detachWindow = this.attachWindow()
    // Cursors and stroke previews whose leave or `done` was lost are dropped
    // after PRESENCE_SWEEP_IDLE_MS, instead of haunting the board forever.
    this.sweepTimer = setInterval(() => presenceStore.sweep(), PRESENCE_SWEEP_EVERY_MS)

    // Fault injection for the chaos e2e suite — never in production.
    if (import.meta.env.DEV && typeof window !== 'undefined') {
      ;(window as unknown as Record<string, unknown>).__coboardNet = {
        drop: () => this.socket.simulateDrop(),
        send: (raw: string) => this.socket.sendRaw(raw),
        retry: () => this.resume(),
      }
    }
  }

  /**
   * The three triggers that skip the backoff timer — FLOWS §9.4, E-02.
   *
   * Owned here rather than in a React hook because they are sync policy: the
   * board route should not need to know that a tab coming back to the front
   * means "ping the socket", and a second consumer would register them twice.
   */
  private attachWindow(): () => void {
    if (typeof window === 'undefined') return () => {}
    const onOnline = () => this.resume()
    const onOffline = () => this.socket.goOffline()
    const onVisible = () => {
      if (document.visibilityState === 'visible') this.socket.checkNow()
    }
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }

  private onSocketState(state: ConnectionState): void {
    switch (state) {
      case 'reconnecting':
      case 'offline':
      case 'disconnected':
        this.droppedSince = true
        // Batches waiting on the dead socket fail now and stay queued, rather
        // than holding the outbox for the full ack timeout.
        this.binding?.abort()
        break
      case 'syncing':
        this.syncingCount = this.persistence?.outbox.pending ?? 0
        break
      case 'connected':
        if (this.droppedSince) {
          this.droppedSince = false
          this.callbacks.onBackOnline?.(this.syncingCount)
        }
        break
    }
    this.callbacks.onState(state)
  }

  /**
   * The rejoin was acknowledged. Replay whatever waited out the drop — FIFO,
   * with the original op ids, so the server deduplicates anything it already
   * had (R-SYNC-014) — and only then call the connection whole.
   */
  private onJoined(): void {
    this.persistence?.resume()
    this.checkSynced()
  }

  /** SYNCING ends when the outbox is empty — FLOWS §15.2. */
  private checkSynced(): void {
    if (this.socket.connectionState !== 'syncing') return
    if ((this.persistence?.outbox.pending ?? 0) > 0) return
    this.socket.markSynced()
  }

  /**
   * Open the board.
   *
   * The socket is started FIRST and not awaited, so its handshake overlaps the
   * snapshot fetch rather than following it. Everything it delivers in the
   * meantime is buffered.
   */
  async start(): Promise<BoardSessionResult> {
    void this.socket.connect()

    const state = await getBoardState(this.boardId)
    if (this.disposed) throw new Error('session disposed during load')

    boardStore.getState().loadObjects(state.objects)
    // PRD §7.1 board first paint: measured on the next layer-1 frame.
    armFirstPaint()
    /*
     * A fresh document means a fresh stack — R-UNDO-006. Carrying entries
     * across a load would leave undo holding inverses naming objects this
     * board has never heard of.
     */
    history.clear()

    // Now the socket's buffer drains on top of the snapshot.
    this.sync.snapshotReady(state.seq)

    // The convergence readout — R-CONV-011. Registered once there is a
    // document for the hash to describe.
    setSyncProbe({
      appliedSeq: () => this.sync.appliedSeq,
      pendingOps: () => this.persistence?.outbox.pending ?? 0,
      connection: () => this.socket.connectionState,
    })

    // The canvas can start emitting cursors. Registered only after the
    // snapshot, so nothing is sent about a board we have not loaded.
    setPresenceEmitter(this.presence)

    /*
     * Only editors get an outbox: queueing a viewer's ops builds a pile of
     * work the server will always refuse. A join_ack that raced ahead of the
     * snapshot may already have told us better than the snapshot does.
     */
    this.loadedSeq = state.seq
    const role = this.latestRole ?? state.myRole
    if (role !== 'VIEWER' || state.myRole !== 'VIEWER') this.ensurePersistence()

    return {
      objects: state.objects.length,
      seq: state.seq,
      role: state.myRole,
      name: state.name,
    }
  }

  /**
   * Every role report, live. A viewer promoted mid-session — `role_changed:
   * EDITOR`, or a guest converted to an account — gets the outbox now; without
   * it every edit would go to `emitOps` with no session and vanish.
   */
  private onRole(role: Role): void {
    this.latestRole = role
    if (role !== 'VIEWER') this.ensurePersistence()
    this.callbacks.onRole(role)
  }

  /**
   * Start the outbox and bind it to the socket — once, and only after the
   * snapshot has been applied (R-SYNC-035). Idempotent: a role report that
   * arrives on every rejoin must not restart a live outbox.
   */
  private ensurePersistence(): void {
    if (this.disposed || this.persistence || this.loadedSeq === null) return
    this.persistence = startPersistence(this.boardId, {
      loadSeq: this.loadedSeq,
      discardHistory: ids => history.discard(ids),
      onOrdered: (opId, seq) => this.sync.markOwn(seq, opId),
      onPending: pending => {
        this.callbacks.onPending?.(pending)
        this.checkSynced()
      },
      onNack: ops => {
        /*
         * FLOWS §9.4: an op refused while SYNCING — typically one that names
         * an object someone deleted while we were away — is dropped
         * silently. The board is already put back; a toast for each of a
         * dozen replayed changes would be noise about nothing the user did
         * just now. Refusals of live work are reported.
         */
        if (this.socket.connectionState === 'syncing') return
        this.callbacks.onNack(
          ops.map(op => op.id),
          'NACK',
        )
      },
    })
    /*
     * Kept on the instance, because acks arrive as ordinary messages rather
     * than as responses: `onMessage` has to route them back into whichever
     * in-flight batch is waiting, and it cannot do that without a handle.
     */
    this.binding = createSocketTransport(
      message => this.socket.send(message),
      () => this.socket.isOpen,
    )
    this.persistence.bindSocket(this.binding)
  }

  private onMessage(message: ServerMessage): void {
    // Acks and nacks settle outbox batches; everything else is the engine's.
    this.binding?.settle(message)
    /*
     * Presence is routed FIRST and separately — R-SYNC-001. It has no seq, no
     * ack and no ordering, so putting it through the sync engine's pipeline
     * would be asking a machine built for exactly-once ordered delivery to
     * handle a firehose of messages that are all of those things' opposite.
     */
    handlePresenceMessage(message)
    this.sync.handle(message)
  }

  /** Presence sender, live once the socket is up. */
  readonly presence = createPresenceEmitter(message => this.socket.send(message))

  private onFatalClose(code: number): void {
    if (code === 4004) this.callbacks.onFatal('deleted')
    else if (code === 4003) this.callbacks.onFatal('forbidden')
  }

  /** "Retry now", or the browser came back online. Restarts the backoff. */
  resume(): void {
    this.socket.resume()
    this.persistence?.resume()
  }

  dispose(): void {
    this.disposed = true
    clearInterval(this.sweepTimer)
    this.detachWindow()
    if (import.meta.env.DEV && typeof window !== 'undefined') {
      delete (window as unknown as Record<string, unknown>).__coboardNet
    }
    setSyncProbe(null)
    setPresenceEmitter(null)
    this.presence.dispose()
    presenceStore.clear()
    this.sync.dispose()
    this.socket.close()
    stopPersistence()
    this.persistence = null
    this.binding = null
  }
}
