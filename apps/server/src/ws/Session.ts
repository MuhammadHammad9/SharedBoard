import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import {
  CLOSE_CODES,
  PRESENCE_COLOURS,
  PRESENCE_THROTTLE_MS,
  SERVER_SOCKET_IDLE_TIMEOUT_MS,
  type PresenceUser,
  type Role,
  type ServerMessage,
} from '@coboard/shared'
import { logger, type Logger } from '../lib/logger.js'
import { identityKey, type Identity } from '../lib/identity.js'

/**
 * Presence budget per session — finding 11.
 *
 * A legitimate client sends each presence stream at most every
 * PRESENCE_THROTTLE_MS (20 Hz): cursor, stroke and xform, plus the occasional
 * selection. All four flat out is 80 messages a second, so the rate is set
 * there and the burst at two seconds of it — a stalled tab flushing a backlog
 * is not punished. A script sending thousands a second, each fanned out to
 * fifty sockets, is.
 */
export const PRESENCE_BUCKET = {
  rate: (1000 / PRESENCE_THROTTLE_MS) * 4,
  capacity: (1000 / PRESENCE_THROTTLE_MS) * 8,
} as const

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
  /**
   * FR-RT-011, D-26: admitted to a room already at MAX_USERS_PER_ROOM, so held
   * to VIEWER for the life of this socket whatever the membership says. The
   * op handler refuses every write from it before the permission lookup, and
   * a live role change cannot lift it — only a fresh connection into a room
   * with space can.
   */
  overCapacity = false

  /**
   * Every log line about this socket goes through here, so each one carries
   * `sessionId`, `boardId` and `actor` (Phase 15e). `actor` is the user id, or
   * the literal "guest": a guest id is a bearer credential (D-1) and never
   * reaches a log.
   */
  readonly log: Logger

  private lastSeen = Date.now()
  private closed = false

  /*
   * Presence token bucket — finding 11. In memory, per session: presence is
   * relayed by THIS process and never touches Redis per message (see
   * handlers/presence.ts), so the limiter must not either.
   */
  private presenceTokens = PRESENCE_BUCKET.capacity
  private presenceRefilledAt = Date.now()

  constructor(
    readonly socket: WebSocket,
    readonly boardId: string,
    readonly identity: Identity,
    readonly displayName: string,
    role: Role,
  ) {
    this.role = role
    this.log = logger.child({ sessionId: this.id, boardId, actor: this.actor })
  }

  /** The actor as logged and labelled: a user id, or "guest". */
  get actor(): string {
    return this.identity.kind === 'user' ? this.identity.userId : 'guest'
  }

  /** The account behind this session; null for a guest. */
  get userId(): string | null {
    return this.identity.kind === 'user' ? this.identity.userId : null
  }

  /** A guest's id. A bearer secret (D-1): never put it in an outbound message. */
  get guestId(): string | null {
    return this.identity.kind === 'guest' ? this.identity.guestId : null
  }

  /** For matching live permission changes. Server-side only. */
  get identityKey(): string {
    return identityKey(this.identity)
  }

  /** Any inbound frame counts, not only a ping — TRD §5.1. */
  touch(): void {
    this.lastSeen = Date.now()
  }

  /**
   * Spend one presence token. False means drop the message silently: a
   * cursor that stutters for a hostile sender is the whole cost.
   */
  takePresenceToken(now = Date.now()): boolean {
    const elapsed = Math.max(0, now - this.presenceRefilledAt) / 1000
    this.presenceRefilledAt = now
    this.presenceTokens = Math.min(
      PRESENCE_BUCKET.capacity,
      this.presenceTokens + elapsed * PRESENCE_BUCKET.rate,
    )
    if (this.presenceTokens < 1) return false
    this.presenceTokens -= 1
    return true
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
      this.log.debug({ err: error }, 'socket send failed')
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
      // NEVER the real guest id — defect P-3. It authenticates the guest, so
      // broadcasting it would hand their credential to the whole room.
      guestId: null,
      name: this.displayName,
      colour: this.colour,
      role: this.role,
    }
  }
}
