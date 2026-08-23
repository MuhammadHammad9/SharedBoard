import {
  BROADCAST_BATCH_MS,
  MAX_USERS_PER_ROOM,
  PRESENCE_COLOURS,
  type ServerMessage,
  type ServerOp,
} from '@coboard/shared'
import { logger } from '../lib/logger.js'
import type { Session } from './Session.js'

/**
 * Rooms — the server-side grouping of sessions on one board (TRD §5.1, §5.5).
 *
 * Two things live here that are easy to get wrong elsewhere.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  1. BROADCAST BATCHING, per room, on a 16 ms timer (TRD §5.5).           │
 * │                                                                          │
 * │     Twenty people drawing produce twenty op messages per frame. Batched  │
 * │     they are one. The window is one animation frame, so nothing is       │
 * │     delayed past the next paint the receiver was going to do anyway.     │
 * │                                                                          │
 * │     A NACK IS NEVER BATCHED (R-SYNC-016). An error is a decision the     │
 * │     sender is blocked on, and holding it for 16 ms to keep company with  │
 * │     ops it has nothing to do with is the wrong trade.                    │
 * │                                                                          │
 * │  2. COLOUR ASSIGNMENT is round-robin over the frozen 12-colour presence  │
 * │     palette, server-side (R-UI-013). It must be server-side: a colour    │
 * │     chosen on the client would differ between the participants, and the  │
 * │     whole point of a presence colour is that everyone sees the same      │
 * │     person in the same colour.                                           │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

interface Room {
  sessions: Map<string, Session>
  /** Ops waiting for the batch window to close. */
  pending: ServerOp[]
  /** sessionId excluded from the pending batch — the author, already acked. */
  pendingExcept: Set<string>
  timer: ReturnType<typeof setTimeout> | null
  /** Advances forever; colours repeat every 12 people, which is intended. */
  colourCursor: number
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>()

  /** Test seam so a suite can drive the batch window without waiting. */
  constructor(private readonly batchMs: number = BROADCAST_BATCH_MS) {}

  private room(boardId: string): Room {
    let room = this.rooms.get(boardId)
    if (!room) {
      room = {
        sessions: new Map(),
        pending: [],
        pendingExcept: new Set(),
        timer: null,
        colourCursor: 0,
      }
      this.rooms.set(boardId, room)
    }
    return room
  }

  size(boardId: string): number {
    return this.rooms.get(boardId)?.sessions.size ?? 0
  }

  sessions(boardId: string): Session[] {
    return [...(this.rooms.get(boardId)?.sessions.values() ?? [])]
  }

  get(boardId: string, sessionId: string): Session | undefined {
    return this.rooms.get(boardId)?.sessions.get(sessionId)
  }

  /** True when the room is full — the caller closes with 4029. */
  isFull(boardId: string): boolean {
    return this.size(boardId) >= MAX_USERS_PER_ROOM
  }

  join(session: Session): void {
    const room = this.room(session.boardId)
    session.colour = PRESENCE_COLOURS[room.colourCursor % PRESENCE_COLOURS.length]!
    room.colourCursor += 1
    room.sessions.set(session.id, session)
  }

  leave(session: Session): void {
    const room = this.rooms.get(session.boardId)
    if (!room) return
    room.sessions.delete(session.id)

    if (room.sessions.size === 0) {
      // Flush anything still pending before the room disappears, then drop it.
      // Leaving empty rooms in the map is a slow memory leak on a server that
      // has been up for a week.
      if (room.timer) {
        clearTimeout(room.timer)
        room.timer = null
      }
      this.rooms.delete(session.boardId)
    }
  }

  /** Immediate, unbatched. Presence, join/leave, and every nack. */
  broadcast(boardId: string, message: ServerMessage, exceptSessionId?: string): void {
    const room = this.rooms.get(boardId)
    if (!room) return
    for (const session of room.sessions.values()) {
      if (session.id === exceptSessionId) continue
      session.send(message)
    }
  }

  /**
   * Queue ops for the next batch window.
   *
   * `exceptSessionId` is the author, who has already been acked with the
   * assigned seq and must not receive their own op back — applying it twice is
   * harmless thanks to idempotency, but it doubles the traffic and makes every
   * trace twice as hard to read.
   */
  queueOps(boardId: string, ops: ServerOp[], exceptSessionId: string): void {
    if (ops.length === 0) return
    const room = this.room(boardId)
    room.pending.push(...ops)
    room.pendingExcept.add(exceptSessionId)

    if (room.timer) return
    room.timer = setTimeout(() => this.flush(boardId), this.batchMs)
  }

  /**
   * Send the pending batch.
   *
   * ┌──────────────────────────────────────────────────────────────────────┐
   * │  Ops from DIFFERENT authors can share one batch, and then the        │
   * │  "except" set has more than one member. Excluding all of them would  │
   * │  mean A never receives B's op just because they happened to write in │
   * │  the same 16 ms.                                                     │
   * │                                                                      │
   * │  So the exclusion is per-op, by `actorSessionId`, not per-batch.     │
   * │  Everyone gets every op except their own.                            │
   * └──────────────────────────────────────────────────────────────────────┘
   */
  flush(boardId: string): void {
    const room = this.rooms.get(boardId)
    if (!room) return

    if (room.timer) {
      clearTimeout(room.timer)
      room.timer = null
    }
    if (room.pending.length === 0) return

    const ops = room.pending
    room.pending = []
    room.pendingExcept.clear()

    // Sorted by seq: the client drains contiguously and buffers gaps, so
    // handing it an out-of-order batch would create work it does not need.
    ops.sort((a, b) => a.seq - b.seq)

    for (const session of room.sessions.values()) {
      const forThem = ops.filter(op => op.actorSessionId !== session.id)
      if (forThem.length === 0) continue
      session.send({ t: 'op_batch', ops: forThem })
    }
  }

  /** Board ids with at least one live session — for the presence sweep. */
  boardIds(): string[] {
    return [...this.rooms.keys()]
  }

  /** Every room, for the heartbeat sweep. */
  allSessions(): Session[] {
    const out: Session[] = []
    for (const room of this.rooms.values()) out.push(...room.sessions.values())
    return out
  }

  /** Drop every timer. Called on server shutdown so tests can exit. */
  dispose(): void {
    for (const [boardId, room] of this.rooms) {
      if (room.timer) clearTimeout(room.timer)
      room.timer = null
      logger.debug({ boardId, sessions: room.sessions.size }, 'room disposed')
    }
    this.rooms.clear()
  }
}

export const roomManager = new RoomManager()
