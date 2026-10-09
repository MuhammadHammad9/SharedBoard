import { CLOSE_CODES, type ServerOp } from '@coboard/shared'
import { opService } from '../../services/OpService.js'
import { presenceService } from '../../services/PresenceService.js'
import type { RoomManager } from '../RoomManager.js'
import type { Session } from '../Session.js'

/** How many catch-up ops a join will replay before telling the client to reload. */
export const JOIN_CATCHUP_LIMIT = 2_000

/**
 * `join` — TRD §5.1, FLOWS §2.3 STEP 5.
 *
 * The client opens the socket and fetches the snapshot IN PARALLEL, then
 * buffers what arrives here until the snapshot lands. That ordering is the
 * client's half of the rule; the server's half is this: `join_ack` carries the
 * board's CURRENT seq, so the client knows exactly where the live stream
 * begins and which buffered ops the snapshot already contains (R-SYNC-035).
 *
 * `sinceSeq` is the reconnect case. A client that was at seq 412 and dropped
 * for ten seconds asks for everything after 412 and gets it in one batch
 * rather than re-downloading a snapshot it mostly already has.
 */
export async function handleJoin(
  session: Session,
  rooms: RoomManager,
  sinceSeq: number,
): Promise<void> {
  if (session.joined) return

  /*
   * The room cap, again — finding 10. The upgrade checked it, but sockets
   * that upgraded together all saw the same count before any of them had
   * joined; this is the check that counts what is actually in the room.
   */
  if (rooms.isFull(session.boardId)) {
    session.log.warn('board full: join refused')
    session.close(CLOSE_CODES.RATE_LIMITED, 'Board is full')
    return
  }
  session.joined = true

  const slot = await presenceService.nextColourSlot(session.boardId)
  /*
   * Finding 14: the socket can close during any await below. Its `close`
   * handler has already run `leave` — before this function put it in the
   * room — so carrying on would add a session nobody will ever remove: a
   * ghost on every participant's avatar stack. Bail out after each await.
   */
  if (!session.open) {
    session.joined = false
    return
  }
  rooms.join(session, slot)
  // Record in Redis so other instances can see this session — TRD §15.2.
  void presenceService.touch(session.boardId, session.toPresenceUser())

  const [currentSeq, everywhere] = await Promise.all([
    opService.currentSeq(session.boardId),
    presenceService.list(session.boardId),
  ])
  if (!session.open) {
    // In the room by now, so leave it the way the close handler would have.
    session.joined = false
    rooms.leave(session)
    void presenceService.forget(session.boardId, session.id)
    return
  }

  // Who is already here: this instance's room, plus the sessions other
  // instances recorded in Redis (TRD §15.2). Local entries win — they are
  // the authority for this process and are never stale.
  const local = rooms
    .sessions(session.boardId)
    .filter(other => other.id !== session.id && other.joined)
    .map(other => other.toPresenceUser())
  const known = new Set([session.id, ...local.map(u => u.sessionId)])
  const remote = everywhere
    .filter(entry => !known.has(entry.sessionId))
    .map(({ seenAt: _seenAt, ...user }) => user)

  /*
   * The ack goes out BEFORE the catch-up ops, and before the presence
   * broadcast. It carries the sessionId and colour that every subsequent
   * message is keyed by, so anything sent ahead of it would arrive addressed
   * to a session the client has not been told it is.
   */
  session.send({
    t: 'join_ack',
    seq: currentSeq,
    role: session.role,
    sessionId: session.id,
    colour: session.colour,
    users: [...local, ...remote],
  })

  // Everyone else learns about the arrival. Presence is never persisted and
  // never sequenced — R-SYNC-001.
  rooms.broadcast(
    session.boardId,
    { t: 'presence_join', user: session.toPresenceUser() },
    session.id,
  )

  if (sinceSeq >= currentSeq) return

  /*
   * Catch-up. Beyond the limit, replaying is more expensive than the snapshot
   * the client can fetch instead — so send nothing and let the `join_ack`'s
   * seq tell them how far behind they are. They already know how to load a
   * snapshot; that is how they opened the board.
   */
  const ops = await opService.since(session.boardId, sinceSeq, JOIN_CATCHUP_LIMIT)
  // Closed meanwhile: the close handler has already cleaned up; nothing to send.
  if (ops.length === 0 || !session.open) return

  session.send({
    t: 'op_batch',
    ops: ops.map(op => ({
      id: op.id,
      type: op.type,
      objectId: op.objectId,
      payload: op.payload,
      seq: op.seq,
      // Catch-up ops have no live author to attribute them to, and the client
      // only uses this to skip its own — which, by definition, these are not.
      actorSessionId: 'replay',
    })) as ServerOp[],
  })
}
