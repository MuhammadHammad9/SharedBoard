import type { ClientMessage } from '@coboard/shared'
import { presenceService } from '../../services/PresenceService.js'
import type { RoomManager } from '../RoomManager.js'
import type { Session } from '../Session.js'

/**
 * Presence relay — TRD §5.3, R-SYNC-001.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  THE WHOLE FILE IS THE OTHER HALF OF `handleOp`, AND ALMOST NOTHING      │
 * │  IT DOES IS THE SAME.                                                    │
 * │                                                                          │
 * │            ops                      presence                             │
 * │  persist   yes, to Postgres         NEVER                                │
 * │  seq       assigned                 none                                 │
 * │  ack       yes                      none                                 │
 * │  offline   queued in the outbox     dropped                              │
 * │  rate      low                      20 Hz per user                       │
 * │  if lost   data loss                a cursor stutters                    │
 * │                                                                          │
 * │  So: no transaction, no idempotency key, no ack, no outbox. Validate,    │
 * │  stamp the sender, forward. A presence message that costs a database     │
 * │  round trip at 20 Hz per user is a presence message that will take the   │
 * │  database down at twenty users.                                          │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Unbatched, deliberately. The room's 16 ms batcher exists to collapse op
 * broadcasts; a cursor is already throttled to 20 Hz at the sender, and adding
 * another 16 ms of latency to the one thing whose whole job is to feel
 * immediate is the wrong trade.
 */
export function handlePresence(
  session: Session,
  rooms: RoomManager,
  message: Extract<ClientMessage, { t: 'cursor' | 'sel' | 'stroke' | 'xform' }>,
): void {
  // A socket that has not joined has no room to broadcast into, and no colour
  // or name for anyone to render it with.
  if (!session.joined) return

  /*
   * VIEWERS BROADCAST PRESENCE. This is not an oversight.
   *
   * `handleOp` refuses a viewer because they may not change the document.
   * Presence changes nothing — being able to see where a reviewer is pointing
   * is most of the value of having them in the room at all. The one thing a
   * viewer cannot produce is a `stroke`, because that previews an op they
   * would not be allowed to commit.
   */
  if (message.t === 'stroke' && session.role === 'VIEWER') return

  switch (message.t) {
    case 'cursor':
      rooms.broadcast(
        session.boardId,
        { t: 'cursor', sessionId: session.id, x: message.x, y: message.y },
        session.id,
      )
      return

    case 'sel':
      rooms.broadcast(
        session.boardId,
        { t: 'sel', sessionId: session.id, ids: message.ids },
        session.id,
      )
      return

    case 'stroke':
      rooms.broadcast(
        session.boardId,
        {
          t: 'stroke',
          sessionId: session.id,
          id: message.id,
          // Forwarded as the DELTA the sender sent — R-SYNC-041. Accumulating
          // server-side would mean holding every in-flight stroke in memory
          // for every user, to save the client an array append.
          pts: message.pts,
          done: message.done,
        },
        session.id,
      )
      return

    case 'xform':
      rooms.broadcast(
        session.boardId,
        {
          t: 'xform',
          sessionId: session.id,
          ids: message.ids,
          dx: message.dx,
          dy: message.dy,
        },
        session.id,
      )
      return
  }
}

/**
 * Refresh this session's Redis entry.
 *
 * Called from the heartbeat rather than from every presence message: at 20 Hz
 * per user a Redis write per cursor move is 1,000 writes/second in a room of
 * fifty, to keep a TTL alive that only needs touching every 25 seconds.
 */
export function refreshPresence(session: Session): void {
  void presenceService.touch(session.boardId, session.toPresenceUser())
}
