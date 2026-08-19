import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import {
  CLOSE_CODES,
  PRESENCE_COLOURS,
  SERVER_SOCKET_IDLE_TIMEOUT_MS,
  type PresenceUser,
  type Role,
  type ServerMessage,
} from '@coboard/shared'
import { logger } from '../lib/logger.js'

/**
 * One user's connection to one board — TRD §5.1.
 *
 * A thin wrapper over the socket that owns the three things the handlers need
 * and the socket does not carry: who this is, what they may do, and whether
 * they are still there.
 */
export class Session {
  readonly id = randomUUID()
  readonly joinedAt = Date.now()

  /** Updated in place when a role changes mid-session — FLOWS §9.5. */
  role: Role
  /** Assigned by the room, round-robin. Frozen palette — R-UI-013. */
  colour = PRESENCE_COLOURS[0] as string
  /** Set by `join`; a socket that has not joined may not send ops. */
  joined = false

  private lastSeen = Date.now()
  private closed = false

  constructor(
    readonly socket: WebSocket,
    readonly boardId: string,
    readonly userId: string,
    readonly displayName: string,
    role: Role,
  ) {
    this.role = role
  }

  /** Any inbound frame counts, not only a ping — TRD §5.1. */
  touch(): void {
    this.lastSeen = Date.now()
  }

  get idle(): boolean {
    return Date.now() - this.lastSeen > SERVER_SOCKET_IDLE_TIMEOUT_MS
  }

  get open(): boolean {
    // 1 === WebSocket.OPEN. Compared numerically so this module does not have
    // to import the runtime class purely for a constant.
    return !this.closed && this.socket.readyState === 1
  }

  /**
   * Send one message.
   *
   * Swallows send failures on purpose: a socket that died between the room's
   * membership check and this call is a normal race, not an error worth
   * failing an op over. The heartbeat sweep removes it shortly after.
   */
  send(message: ServerMessage): void {
    if (!this.open) return
    try {
      this.socket.send(JSON.stringify(message))
    } catch (error) {
      logger.debug({ err: error, sessionId: this.id }, 'socket send failed')
    }
  }

  close(code: number = CLOSE_CODES.NORMAL, reason = ''): void {
    if (this.closed) return
    this.closed = true
    try {
      this.socket.close(code, reason)
    } catch {
      // Already gone. Nothing to do and nothing to report.
    }
  }

  toPresenceUser(): PresenceUser {
    return {
      sessionId: this.id,
      userId: this.userId,
      guestId: null,
      name: this.displayName,
      colour: this.colour,
      role: this.role,
    }
  }
}
