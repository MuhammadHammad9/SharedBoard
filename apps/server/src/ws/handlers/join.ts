import type { ServerOp } from '@coboard/shared'
import { opService } from '../../services/OpService.js'
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
  session.joined = true

  rooms.join(session)

  const currentSeq = await opService.currentSeq(session.boardId)

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
    users: rooms
      .sessions(session.boardId)
      .filter(other => other.id !== session.id && other.joined)
      .map(other => other.toPresenceUser()),
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
  if (ops.length === 0) return

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
