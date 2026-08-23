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

export interface BoardSessionCallbacks {
  onState: (state: ConnectionState) => void
  onRole: (role: Role) => void
  onNack: (opIds: string[], code: string) => void
  onFatal: (kind: 'deleted' | 'forbidden') => void
  onBoardRenamed?: (name: string) => void
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

  constructor(
    readonly boardId: string,
    private readonly callbacks: BoardSessionCallbacks,
  ) {
    this.socket = new SocketClient(boardId, {
      // Every connect re-joins with our applied seq, so a reconnect replays
      // only the gap rather than reloading the board.
      onOpen: () => this.sync.join(),
      onMessage: message => this.onMessage(message),
      onState: state => this.callbacks.onState(state),
      onFatal: code => this.onFatalClose(code),
    })

    this.sync = new SyncEngine(
      boardId,
      {
        onState: callbacks.onState,
        onRole: callbacks.onRole,
        onNack: callbacks.onNack,
        onFatal: callbacks.onFatal,
        ...(callbacks.onBoardRenamed ? { onBoardRenamed: callbacks.onBoardRenamed } : {}),
      },
      {
        send: message => this.socket.send(message),
        markSynced: () => this.socket.markSynced(),
      },
    )
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
    /*
     * A fresh document means a fresh stack — R-UNDO-006. Carrying entries
     * across a load would leave undo holding inverses naming objects this
     * board has never heard of.
     */
    history.clear()

    // Now the socket's buffer drains on top of the snapshot.
    this.sync.snapshotReady(state.seq)

    // The canvas can start emitting cursors. Registered only after the
    // snapshot, so nothing is sent about a board we have not loaded.
    setPresenceEmitter(this.presence)

    // Only editors get an outbox: queueing a viewer's ops builds a pile of
    // work the server will always refuse.
    if (state.myRole !== 'VIEWER') {
      this.persistence = startPersistence(this.boardId, {
        onNack: ops =>
          this.callbacks.onNack(
            ops.map(op => op.id),
            'NACK',
          ),
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

    return {
      objects: state.objects.length,
      seq: state.seq,
      role: state.myRole,
      name: state.name,
    }
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

  /** The browser came back online. */
  resume(): void {
    this.socket.resume()
    this.persistence?.resume()
  }

  dispose(): void {
    this.disposed = true
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
