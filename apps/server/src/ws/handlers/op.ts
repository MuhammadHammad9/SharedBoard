import {
  canEdit,
  ClientOpSchema,
  NACK_CODES,
  type ClientOp,
  type ServerOp,
} from '@coboard/shared'
import { AuthError } from '../../services/AuthService.js'
import { opService } from '../../services/OpService.js'
import { snapshotService } from '../../services/SnapshotService.js'
import { consume } from '../../lib/tokenBucket.js'
import { logger } from '../../lib/logger.js'
import type { RoomManager } from '../RoomManager.js'
import type { Session } from '../Session.js'

/**
 * The op handler — TRD §5.4. Seven steps, in this exact order.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  THE ORDER IS THE SPECIFICATION, not an implementation detail.           │
 * │                                                                          │
 * │  1 AUTHORIZE    before anything else, so a viewer's forged op costs the  │
 * │                 server one comparison and touches nothing (R-SEC-001).   │
 * │  2 VALIDATE     before the rate limiter, so malformed input cannot spend │
 * │                 another user's budget through a shared key.              │
 * │  3 RATE LIMIT   before persistence, so refusing is cheaper than doing.   │
 * │  4 IDEMPOTENCY  before the insert, so a reconnect replay re-acks rather  │
 * │                 than duplicating the object (R-SYNC-014).                │
 * │  5 PERSIST      transactionally, with the seq assigned inside the same   │
 * │                 transaction (R-SYNC-013).                                │
 * │  6 ACK SENDER   FIRST — they are blocked, waiting to clear their outbox. │
 * │  7 BROADCAST    to the rest of the room, batched (R-SYNC-015, R-SYNC-017)│
 * │                                                                          │
 * │  Six before seven is the one people reorder, and it is the one that      │
 * │  matters most: ack is durability confirmation to a client that will      │
 * │  otherwise retry, and broadcast is a courtesy to everyone else.          │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Steps 4 and 5 are delegated to `OpService.append`, which Phase 8 already
 * wrote and tested against a real Postgres — including the concurrency case.
 * Calling it here rather than reimplementing the transaction is the whole
 * reason the service exists: TRD §5.4 must not be enforced on the REST path
 * and forgotten on the socket path.
 */

const nack = (session: Session, id: string, code: string, message: string): void => {
  // Never batched — R-SYNC-016. An error is a decision the sender is blocked
  // on, and delaying it 16 ms to travel with unrelated ops helps nobody.
  session.send({ t: 'nack', id, code, message })
}

export async function handleOps(
  session: Session,
  rooms: RoomManager,
  incoming: unknown[],
): Promise<void> {
  // STEP 1 — AUTHORIZE. Every message. No exceptions.
  if (!canEdit(session.role)) {
    for (const raw of incoming) {
      nack(session, opId(raw), NACK_CODES.FORBIDDEN, 'View-only access')
    }
    return
  }

  // STEP 2 — VALIDATE. Reject, never coerce (R-SEC-003). Each op is judged
  // on its own, so one malformed op in a batch of forty does not discard the
  // thirty-nine that were fine.
  const valid: ClientOp[] = []
  for (const raw of incoming) {
    const parsed = ClientOpSchema.safeParse(raw)
    if (!parsed.success) {
      nack(session, opId(raw), NACK_CODES.INVALID_OP, 'Malformed operation')
      continue
    }
    valid.push(parsed.data)
  }
  if (valid.length === 0) return

  // STEP 3 — RATE LIMIT. Costed per op, so a 40-object paste spends 40 tokens
  // rather than 1; the budget is about how much work reaches the database.
  const allowed = await consume(session.id, valid.length)
  if (!allowed) {
    for (const op of valid) nack(session, op.id, NACK_CODES.RATE_LIMITED, 'Slow down')
    return
  }

  // STEPS 4 AND 5 — idempotency and transactional persistence.
  let result: Awaited<ReturnType<typeof opService.append>>
  try {
    result = await opService.append(session.boardId, valid, { userId: session.userId })
  } catch (error) {
    if (error instanceof AuthError) {
      const code =
        error.status === 404 ? NACK_CODES.BOARD_GONE : NACK_CODES.INVALID_OP
      for (const op of valid) nack(session, op.id, code, error.message)
      return
    }
    /*
     * An unexpected failure is NOT acked. The client's outbox keeps the ops
     * and retries, which is exactly right: acking here would tell a client its
     * work is durable when it is not, and that is the one lie the whole
     * zero-loss guarantee rests on never telling (R-SYNC-012).
     */
    logger.error({ err: error, boardId: session.boardId }, 'op persist failed')
    for (const op of valid) {
      nack(session, op.id, NACK_CODES.INVALID_OP, 'Could not save that change')
    }
    return
  }

  // STEP 6 — ACK THE SENDER FIRST.
  session.send({
    t: 'ack',
    ids: result.applied.map(op => op.id),
    seqs: result.applied.map(op => op.seq),
  })

  // STEP 7 — BROADCAST to the rest of the room.
  //
  // Duplicates are excluded: they were stored on an earlier attempt and
  // already broadcast then. Re-sending them would be harmless — the client
  // drops ops at or below `lastAppliedSeq` — but it would also mean a flaky
  // connection re-broadcasts its whole backlog to everyone on every retry.
  const fresh: ServerOp[] = result.applied
    .filter(op => !op.duplicate)
    .map(op => ({
      id: op.id,
      type: op.type,
      objectId: op.objectId,
      payload: op.payload,
      seq: op.seq,
      actorSessionId: session.id,
    })) as ServerOp[]

  rooms.queueOps(session.boardId, fresh, session.id)

  /*
   * Snapshot check, un-awaited and after the ack — the same posture as the
   * REST path. Materialising 10,000 objects inside the op that happened to be
   * the 500th would make one unlucky user's stroke visibly slower than the 499
   * before it, against a 16 ms input-to-pixel budget.
   */
  if (fresh.length > 0) void snapshotService.maybeSnapshot(session.boardId)
}

/** Best-effort id extraction, so even a malformed op can be nacked by name. */
function opId(raw: unknown): string {
  const id = (raw as { id?: unknown } | null)?.id
  return typeof id === 'string' ? id : 'unknown'
}
