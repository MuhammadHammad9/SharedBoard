import {
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
import { track } from '../../lib/analytics.js'
import { backoffFor } from './backoff.js'
import { transition, type ConnectionEvent } from './ConnectionMachine.js'

export { backoffFor }

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
  /**
   * A reconnect attempt is starting — "Reconnecting… (attempt {N})". Separate
   * from `onState` because the state stays RECONNECTING across attempts.
   */
  onAttempt?: (attempt: number) => void
  /** Unsent ops right now — reported with PRD §9 `socket_reconnected`. */
  outboxSize?: () => number
}

/** Injected in tests so nothing has to wait out a real backoff. */
export interface SocketDeps {
  connect?: (url: string) => WebSocket
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * A close code as a short PRD §9 `socket_disconnected` reason. A code we have
 * no name for is reported as the number, which is still groupable.
 */
export function disconnectReason(code: number): string {
  switch (code) {
    case CLOSE_CODES.NORMAL:
      return 'normal'
    case CLOSE_CODES.GOING_AWAY:
      return 'going_away'
    case CLOSE_CODES.ABNORMAL:
      return 'abnormal'
    case CLOSE_CODES.UNAUTHORIZED:
      return 'unauthorized'
    case CLOSE_CODES.FORBIDDEN:
      return 'forbidden'
    case CLOSE_CODES.NOT_FOUND:
      return 'not_found'
    case CLOSE_CODES.RATE_LIMITED:
      return 'rate_limited'
    default:
      return `code_${code}`
  }
}

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
  /**
   * A connect is between its ticket request and the socket it opens. The
   * `this.socket` guard cannot cover that window — there is no socket yet —
   * and `online` plus `visibilitychange` firing together on wake would each
   * fetch a ticket and open a socket of their own.
   */
  private connecting = false
  /**
   * Bumped by `restart()`, so a ticket fetched under the previous identity is
   * abandoned rather than used to open a second socket beside the new one.
   */
  private generation = 0

  /*
   * PRD §9 socket_disconnected / socket_reconnected bookkeeping. `openedAt`
   * is set while a socket is open; `droppedAt` from an unplanned close until
   * the next successful open, and `reconnectAttempts` counts the connects
   * made in between (separate from `attempt`, which `resume()` resets).
   */
  private openedAt: number | null = null
  private droppedAt: number | null = null
  private reconnectAttempts = 0

  private pingTimer: unknown = null
  private pongTimer: unknown = null
  private retryTimer: unknown = null

  private readonly open: (url: string) => WebSocket
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly now: () => number

  constructor(
    private readonly boardId: string,
    private readonly handlers: SocketHandlers,
    deps: SocketDeps = {},
  ) {
    this.open = deps.connect ?? (url => new WebSocket(url))
    this.setTimer = deps.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? (h => globalThis.clearTimeout(h as number))
    this.now = deps.now ?? (() => Date.now())
  }

  get connectionState(): ConnectionState {
    return this.state
  }

  /** Which reconnect attempt is in flight — "Reconnecting… (attempt {N})". */
  get reconnectAttempt(): number {
    return this.attempt
  }

  get isOpen(): boolean {
    return this.socket?.readyState === 1
  }

  /**
   * Every state change goes through the table in ConnectionMachine.ts. An
   * event the current state does not accept is ignored — returning false so
   * the caller can tell.
   */
  private fire(event: ConnectionEvent): boolean {
    const next = transition(this.state, event)
    if (next === null) return false
    if (next !== this.state) {
      this.state = next
      this.handlers.onState(next)
    }
    return true
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
    if (this.connecting) return
    if (this.socket && this.socket.readyState <= 1) return
    this.connecting = true
    const generation = this.generation

    // From DISCONNECTED this is the first connect; from OFFLINE it is a
    // retry. From RECONNECTING it is the next attempt and nothing changes.
    this.fire('connect')
    if (this.droppedAt !== null) this.reconnectAttempts += 1

    let ticket: string
    try {
      const response = await api.post<{ ticket: string }>('/ws/ticket', {
        boardId: this.boardId,
      })
      ticket = response.ticket
    } catch {
      // Superseded by a restart while the request was out: that connect owns
      // the retry now.
      if (generation !== this.generation) return
      this.connecting = false
      // Could not even get a ticket — the API is down or the session expired.
      // Treated as a network failure, because that is what it usually is.
      this.scheduleRetry()
      return
    }
    if (generation !== this.generation) return
    this.connecting = false
    if (this.closedByUs) return

    const url = new URL(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
    )
    url.searchParams.set('ticket', ticket)

    const socket = this.open(url.toString())
    this.socket = socket

    socket.onopen = () => {
      // Opened after we gave up on it — the board unmounted mid-handshake.
      if (this.closedByUs || this.socket !== socket) {
        try {
          socket.close(CLOSE_CODES.NORMAL)
        } catch {
          // Already gone.
        }
        return
      }
      this.attempt = 0
      this.refreshedOnce = false
      this.openedAt = this.now()
      if (this.droppedAt !== null) {
        track('socket_reconnected', {
          attempts: this.reconnectAttempts,
          downtime_ms: this.openedAt - this.droppedAt,
          outbox_size: this.handlers.outboxSize?.() ?? 0,
        })
        this.droppedAt = null
        this.reconnectAttempts = 0
      }
      this.fire('open')
      this.startHeartbeat()
      this.handlers.onOpen()
    }

    socket.onmessage = event => {
      // A socket we have already replaced or given up on speaks for nothing.
      if (this.socket !== socket) return
      const parsed = safeParse(event.data)
      if (!parsed) return

      // Every inbound message is proof of life, not only a pong. A busy board
      // may deliver ops continuously and never need the ping at all.
      this.clearPongTimer()

      if (parsed.t === 'pong') return
      this.handlers.onMessage(parsed)
    }

    /*
     * Only the CURRENT socket's close is a drop. A superseded socket closing
     * late — after a restart, a heartbeat teardown, or a duplicate connect —
     * would otherwise stop the live socket's heartbeat, null it and report
     * 'disconnected' while it is perfectly healthy.
     */
    socket.onclose = event => {
      if (this.socket !== socket) return
      this.onClose(event.code)
    }
    socket.onerror = () => {
      // `error` is always followed by `close`, which is where the reaction
      // lives. Handling both would double every reconnect.
    }
  }

  /**
   * SYNCING → CONNECTED. Called by the board session once the rejoin has been
   * acknowledged AND the outbox has drained — FLOWS §15.2. Not at `join_ack`:
   * a header that turns green while twelve offline changes are still on
   * their way is reporting a guarantee it does not yet have.
   */
  markSynced(): void {
    this.fire('synced')
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
    // Leaving the board is not a disconnect — nothing is tracked.
    this.openedAt = null
    this.stopTimers()
    this.fire('close')
    try {
      this.socket?.close(CLOSE_CODES.NORMAL)
    } catch {
      // Already gone.
    }
    this.socket = null
  }

  private onClose(code: number, reason?: string): void {
    this.stopTimers()
    this.socket = null
    if (this.closedByUs) return

    // PRD §9: only a connection that was actually open can be "lost". A
    // reconnect attempt that never opened is not a second disconnect.
    if (this.openedAt !== null) {
      const at = this.now()
      track('socket_disconnected', {
        reason: reason ?? disconnectReason(code),
        session_duration_ms: at - this.openedAt,
      })
      this.openedAt = null
      this.droppedAt = at
      this.reconnectAttempts = 0
    }

    const reaction = reactionTo(code)

    if (reaction === 'stop') {
      this.fire('close')
      this.handlers.onFatal(code)
      return
    }

    if (reaction === 'refresh-then-retry') {
      if (this.refreshedOnce) {
        // Second 4001 in a row. The session is gone, not stale.
        this.fire('close')
        this.handlers.onFatal(code)
        return
      }
      this.refreshedOnce = true
      // The ticket request itself goes through `api`, which refreshes on a
      // 401 and replays — so simply reconnecting IS the refresh.
      this.fire('drop')
      void this.connect()
      return
    }

    // 4029 asks for a longer wait than a plain network drop.
    this.scheduleRetry(code === CLOSE_CODES.RATE_LIMITED ? 30_000 : undefined)
  }

  private scheduleRetry(fixedDelayMs?: number): void {
    if (this.closedByUs || this.retryTimer !== null) return

    // FLOWS §9.4: the browser saying it has no network is OFFLINE at once.
    // Retrying into a dead interface only burns the attempt budget; the
    // `online` event brings us back through `resume()`.
    if (browserOffline()) {
      this.fire('browser-offline')
      return
    }

    this.attempt += 1
    if (this.attempt > MAX_RECONNECT_ATTEMPTS) {
      /*
       * Give up ACTIVE retrying, but do not declare the session dead: the
       * outbox still holds the user's work, and `resume()` from the browser's
       * `online` event will start again. 'offline' is the state that tells the
       * header to say so rather than pretending to be connected.
       */
      this.fire('exhausted')
      return
    }

    // From CONNECTED or SYNCING this is the drop; from RECONNECTING it is
    // already true and the table leaves it be.
    this.fire('drop')
    this.handlers.onAttempt?.(this.attempt)
    this.retryTimer = this.setTimer(
      () => {
        this.retryTimer = null
        void this.connect()
      },
      fixedDelayMs ?? backoffFor(this.attempt),
    )
  }

  /**
   * Retry NOW — the browser came back online, or the user pressed "Retry
   * now". The backoff restarts from attempt 1 (FLOWS §9.4).
   */
  resume(): void {
    if (this.closedByUs || this.isOpen) return
    if (this.retryTimer !== null) {
      this.clearTimer(this.retryTimer)
      this.retryTimer = null
    }
    this.attempt = 0
    void this.connect()
  }

  /**
   * The browser announced it has no network. Say so immediately rather than
   * after the heartbeat notices — the socket may still read OPEN for tens of
   * seconds while every send disappears.
   */
  goOffline(): void {
    if (this.closedByUs) return
    if (this.retryTimer !== null) {
      this.clearTimer(this.retryTimer)
      this.retryTimer = null
    }
    this.fire('browser-offline')
  }

  /**
   * E-02: the tab came back to the front. A backgrounded tab's socket is
   * often silently dead — the OS suspended it, the NAT forgot it — and the
   * 25 s heartbeat may be throttled to minutes. If the socket claims to be
   * open, ping it now and let the pong timeout decide; if not, reconnect.
   */
  checkNow(): void {
    if (this.closedByUs) return
    if (this.isOpen) {
      this.stopHeartbeat()
      this.ping()
      return
    }
    this.resume()
  }

  /*
   * ── Fault injection, development builds only ─────────────────────────────
   *
   * The chaos e2e suite (AT-30 … AT-35) needs to cut a live connection the
   * way a network does — no close frame, no warning — and Playwright's
   * `setOffline` does not reliably sever a WebSocket that is already open.
   * These do exactly that and nothing else; the session only exposes them on
   * `window` when `import.meta.env.DEV`.
   */

  /** Sever the connection as a dead network would: 1006, then reconnect. */
  simulateDrop(): void {
    const socket = this.socket
    if (!socket || this.closedByUs) return
    socket.onclose = null
    socket.onmessage = null
    try {
      socket.close(3000)
    } catch {
      // Already gone.
    }
    this.onClose(CLOSE_CODES.ABNORMAL)
  }

  /**
   * Reconnect now, under whatever credential is current — guest → account
   * conversion (FLOWS §7.4). The canvas, the outbox and the applied seq all
   * stay; only the socket's identity changes, so the rejoin replays nothing
   * the document does not already have.
   */
  restart(): void {
    if (this.closedByUs) return
    const socket = this.socket
    this.stopTimers()
    this.socket = null
    // A ticket request still in flight belongs to the old identity.
    this.generation += 1
    this.connecting = false
    // A planned swap of identity, not a drop: nothing is tracked for it.
    this.openedAt = null
    if (socket) {
      socket.onclose = null
      socket.onmessage = null
      try {
        socket.close(CLOSE_CODES.NORMAL)
      } catch {
        // Already gone.
      }
    }
    this.attempt = 0
    this.fire('drop')
    void this.connect()
  }

  /** Put arbitrary bytes on the wire — AT-35's forged console message. */
  sendRaw(data: string): boolean {
    if (!this.isOpen) return false
    this.socket!.send(data)
    return true
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
      this.onClose(CLOSE_CODES.ABNORMAL, 'heartbeat_timeout')
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

function browserOffline(): boolean {
  const nav = globalThis.navigator as { onLine?: boolean } | undefined
  return nav?.onLine === false
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
