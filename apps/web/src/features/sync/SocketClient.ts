import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  CLOSE_CODES,
  MAX_RECONNECT_ATTEMPTS,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  ServerMessageSchema,
  type ClientMessage,
  type ConnectionState,
  type ServerMessage,
} from '@coboard/shared'
import { api } from '../../lib/api.js'

/**
 * The socket transport — TRD §5.1, §5.6, §10.2.
 *
 * Owns exactly one thing: keeping a live, authenticated connection to one
 * board, and handing whole validated messages to whoever asked. It knows
 * nothing about ops, sequence numbers or the document — that is `SyncEngine`.
 * The split is what makes the reconnection logic testable without a board.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  THE HEARTBEAT IS NOT REDUNDANT WITH THE `close` EVENT — R-SYNC-032.     │
 * │                                                                          │
 * │  A half-open TCP connection does not close. The laptop lid shuts, the    │
 * │  wifi hands over, a NAT drops the mapping: the socket stays `OPEN` and   │
 * │  every send succeeds into a void, potentially for minutes. The only way  │
 * │  to know is to ask and time the answer.                                  │
 * │                                                                          │
 * │  Ping every 25 s, expect a pong within 10 s, tear down and reconnect if  │
 * │  it does not arrive. Waiting for `close` means the user draws into a     │
 * │  dead connection and finds out when they reload.                         │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

export interface SocketHandlers {
  /**
   * The socket is open and ready for `join`.
   *
   * Fires on EVERY connect, not only the first: a reconnect must re-join, and
   * carrying `sinceSeq` is what makes the server replay exactly what was
   * missed instead of the client re-downloading a snapshot.
   */
  onOpen: () => void
  onMessage: (message: ServerMessage) => void
  onState: (state: ConnectionState) => void
  /** A close the client must not retry — 4001/4003/4004. */
  onFatal: (code: number) => void
}

/** Injected in tests so nothing has to wait out a real backoff. */
export interface SocketDeps {
  connect?: (url: string) => WebSocket
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * Full jitter — R-SYNC-030.
 *
 * `random() * ceiling`, never the ceiling itself. A server that restarts with
 * two hundred boards attached gets two hundred reconnects spread across the
 * window rather than two hundred arriving in the same millisecond and killing
 * it again. Without the jitter the reconnect storm is self-sustaining.
 */
export const backoffFor = (attempt: number): number =>
  Math.random() * Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempt, 5))

/**
 * Close codes and what the client does about them — TRD §5.6.
 *
 * The distinction that matters: a NETWORK failure is retried forever with
 * backoff, and a DECISION is not retried at all. Reconnecting into a 4003
 * would spin against a server that has already made up its mind.
 */
export function reactionTo(code: number): 'retry' | 'stop' | 'refresh-then-retry' {
  switch (code) {
    case CLOSE_CODES.NORMAL:
    case CLOSE_CODES.GOING_AWAY:
      return 'stop'
    case CLOSE_CODES.UNAUTHORIZED:
      // The token aged out. Refresh and try ONCE more; a second 4001 means the
      // session is genuinely gone, not merely stale.
      return 'refresh-then-retry'
    case CLOSE_CODES.FORBIDDEN:
    case CLOSE_CODES.NOT_FOUND:
      return 'stop'
    default:
      return 'retry'
  }
}

export class SocketClient {
  private socket: WebSocket | null = null
  private state: ConnectionState = 'disconnected'
  private attempt = 0
  private closedByUs = false
  private refreshedOnce = false

  private pingTimer: unknown = null
  private pongTimer: unknown = null
  private retryTimer: unknown = null

  private readonly open: (url: string) => WebSocket
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(
    private readonly boardId: string,
    private readonly handlers: SocketHandlers,
    deps: SocketDeps = {},
  ) {
    this.open = deps.connect ?? (url => new WebSocket(url))
    this.setTimer = deps.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? (h => globalThis.clearTimeout(h as number))
  }

  get connectionState(): ConnectionState {
    return this.state
  }

  get isOpen(): boolean {
    return this.socket?.readyState === 1
  }

  private setState(state: ConnectionState): void {
    if (state === this.state) return
    this.state = state
    this.handlers.onState(state)
  }

  /**
   * Fetch a ticket and open the socket.
   *
   * The ticket is fetched fresh on every attempt, not cached: it lives 60
   * seconds and is single-use, so a reconnect four minutes into a backoff
   * would present a ticket the server deleted long ago and get a 401 it would
   * then treat as an auth failure rather than as staleness.
   */
  async connect(): Promise<void> {
    if (this.closedByUs) return
    if (this.socket && this.socket.readyState <= 1) return

    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting')

    let ticket: string
    try {
      const response = await api.post<{ ticket: string }>('/ws/ticket', {
        boardId: this.boardId,
      })
      ticket = response.ticket
    } catch {
      // Could not even get a ticket — the API is down or the session expired.
      // Treated as a network failure, because that is what it usually is.
      this.scheduleRetry()
      return
    }
    if (this.closedByUs) return

    const url = new URL(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
    url.searchParams.set('ticket', ticket)

    const socket = this.open(url.toString())
    this.socket = socket

    socket.onopen = () => {
      this.attempt = 0
      this.refreshedOnce = false
      this.setState('syncing')
      this.startHeartbeat()
      this.handlers.onOpen()
    }

    socket.onmessage = event => {
      const parsed = safeParse(event.data)
      if (!parsed) return

      // Every inbound message is proof of life, not only a pong. A busy board
      // may deliver ops continuously and never need the ping at all.
      this.clearPongTimer()

      if (parsed.t === 'pong') return
      this.handlers.onMessage(parsed)
    }

    socket.onclose = event => this.onClose(event.code)
    socket.onerror = () => {
      // `error` is always followed by `close`, which is where the reaction
      // lives. Handling both would double every reconnect.
    }
  }

  /** Called by SyncEngine once `join_ack` has been processed. */
  markSynced(): void {
    if (this.state === 'syncing') this.setState('connected')
  }

  send(message: ClientMessage): boolean {
    if (!this.isOpen) return false
    try {
      this.socket!.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  /** A deliberate close. No reconnect follows. */
  close(): void {
    this.closedByUs = true
    this.stopTimers()
    this.setState('disconnected')
    try {
      this.socket?.close(CLOSE_CODES.NORMAL)
    } catch {
      // Already gone.
    }
    this.socket = null
  }

  private onClose(code: number): void {
    this.stopTimers()
    this.socket = null
    if (this.closedByUs) return

    const reaction = reactionTo(code)

    if (reaction === 'stop') {
      this.setState('disconnected')
      this.handlers.onFatal(code)
      return
    }

    if (reaction === 'refresh-then-retry') {
      if (this.refreshedOnce) {
        // Second 4001 in a row. The session is gone, not stale.
        this.setState('disconnected')
        this.handlers.onFatal(code)
        return
      }
      this.refreshedOnce = true
      // The ticket request itself goes through `api`, which refreshes on a
      // 401 and replays — so simply reconnecting IS the refresh.
      this.setState('reconnecting')
      void this.connect()
      return
    }

    // 4029 asks for a longer wait than a plain network drop.
    this.scheduleRetry(code === CLOSE_CODES.RATE_LIMITED ? 30_000 : undefined)
  }

  private scheduleRetry(fixedDelayMs?: number): void {
    if (this.closedByUs || this.retryTimer !== null) return

    this.attempt += 1
    if (this.attempt > MAX_RECONNECT_ATTEMPTS) {
      /*
       * Give up ACTIVE retrying, but do not declare the session dead: the
       * outbox still holds the user's work, and `resume()` from the browser's
       * `online` event will start again. 'offline' is the state that tells the
       * header to say so rather than pretending to be connected.
       */
      this.setState('offline')
      return
    }

    this.setState('reconnecting')
    this.retryTimer = this.setTimer(
      () => {
        this.retryTimer = null
        void this.connect()
      },
      fixedDelayMs ?? backoffFor(this.attempt),
    )
  }

  /** Manual retry — the browser came back online, or the user asked. */
  resume(): void {
    if (this.closedByUs || this.isOpen) return
    if (this.retryTimer !== null) {
      this.clearTimer(this.retryTimer)
      this.retryTimer = null
    }
    this.attempt = 0
    void this.connect()
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.pingTimer = this.setTimer(() => this.ping(), PING_INTERVAL_MS)
  }

  private ping(): void {
    if (!this.isOpen) return
    this.send({ t: 'ping' })

    this.pongTimer = this.setTimer(() => {
      /*
       * No answer in 10 s. The connection is half-open: `readyState` still
       * says OPEN and every send has been succeeding into nothing. Tear it
       * down ourselves rather than waiting for a `close` that may never come.
       */
      this.pongTimer = null
      try {
        this.socket?.close(CLOSE_CODES.ABNORMAL)
      } catch {
        // Nothing to close.
      }
      this.onClose(CLOSE_CODES.ABNORMAL)
    }, PONG_TIMEOUT_MS)

    this.pingTimer = this.setTimer(() => this.ping(), PING_INTERVAL_MS)
  }

  private clearPongTimer(): void {
    if (this.pongTimer === null) return
    this.clearTimer(this.pongTimer)
    this.pongTimer = null
  }

  private stopHeartbeat(): void {
    if (this.pingTimer !== null) {
      this.clearTimer(this.pingTimer)
      this.pingTimer = null
    }
    this.clearPongTimer()
  }

  private stopTimers(): void {
    this.stopHeartbeat()
    if (this.retryTimer !== null) {
      this.clearTimer(this.retryTimer)
      this.retryTimer = null
    }
  }
}

/**
 * Parse and VALIDATE — R-SEC-003 applies at the socket boundary too.
 *
 * The server is ours, but the connection is not: anything that can reach the
 * page can reach this handler, and an unvalidated `NaN` in a coordinate
 * propagates through the renderer and blanks the canvas.
 */
function safeParse(data: unknown): ServerMessage | null {
  try {
    const parsed = ServerMessageSchema.safeParse(JSON.parse(String(data)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
