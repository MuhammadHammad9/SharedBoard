import type { Prisma, PrismaClient } from '@prisma/client'
import { ERROR_CODES, MAX_OBJECTS_PER_BOARD, type ClientOp } from '@coboard/shared'
import { AuthError } from './AuthService.js'
import { prisma as defaultPrisma } from '../lib/prisma.js'

/**
 * The op log — TRD §3.2 and §5.4, decision D-3.
 *
 * This service is written once and used twice: over REST in Phase 8, and by
 * the WebSocket gateway in Phase 9. Sharing it is not tidiness — TRD §5.4
 * fixes the order of operations for appending an op (authorize, validate,
 * rate limit, idempotency, persist, ack, broadcast), and having two
 * implementations of that sequence is how an authorization rule ends up
 * enforced on one path and forgotten on the other.
 */

export interface AppendedOp {
  id: string
  seq: number
  type: 'CREATE' | 'UPDATE' | 'DELETE'
  objectId: string
  payload: unknown
  /** True when this op id had already been stored — R-SYNC-014. */
  duplicate: boolean
}

export interface Actor {
  userId?: string
  guestId?: string
}

export class OpService {
  constructor(private readonly db: PrismaClient = defaultPrisma) {}

  /**
   * Append a batch of ops and assign each a sequence number.
   *
   * ┌──────────────────────────────────────────────────────────────────────┐
   * │  SEQUENCE ASSIGNMENT — R-SYNC-013 (Blocking)                         │
   * │                                                                      │
   * │  NEVER `SELECT MAX(seq)` and then insert. Two concurrent appends     │
   * │  both read the same maximum, both write the same seq, and the        │
   * │  board's history now has two ops claiming one position — which is    │
   * │  a divergence no client can resolve.                                 │
   * │                                                                      │
   * │  Instead: `UPDATE board SET currentSeq = currentSeq + 1 RETURNING`   │
   * │  inside a transaction. Postgres takes a row lock on that board for   │
   * │  the duration, so concurrent appends to the SAME board serialise     │
   * │  while appends to different boards stay fully parallel. The lock is  │
   * │  held for microseconds — the increment and one insert.               │
   * └──────────────────────────────────────────────────────────────────────┘
   *
   * The whole batch is one transaction. A partially-applied batch would let
   * a paste of five objects land as three, with no record that two are
   * missing.
   */
  async append(
    boardId: string,
    ops: readonly ClientOp[],
    actor: Actor,
  ): Promise<{ applied: AppendedOp[]; currentSeq: number }> {
    if (ops.length === 0) {
      const board = await this.db.board.findUnique({
        where: { id: boardId },
        select: { currentSeq: true },
      })
      return { applied: [], currentSeq: board?.currentSeq ?? 0 }
    }

    return this.db.$transaction(async tx => {
      const board = await tx.board.findUnique({
        where: { id: boardId },
        select: { id: true, deletedAt: true, currentSeq: true },
      })
      if (!board || board.deletedAt) {
        throw new AuthError(ERROR_CODES.NOT_FOUND, 'Board not found', 404)
      }

      /*
       * Idempotency — R-SYNC-014, TRD §5.4 step 4.
       *
       * An op id already in the log means the client retried after a dropped
       * response. Re-acknowledge it with the seq it ALREADY has; inserting
       * again would duplicate the object. This is the entire reason the op id
       * is client-generated and is the primary key.
       */
      const ids = ops.map(op => op.id)
      const existing = await tx.operation.findMany({
        where: { boardId, id: { in: ids } },
        select: { id: true, seq: true, type: true, objectId: true, payload: true },
      })
      const alreadyStored = new Map(existing.map(row => [row.id, row]))

      const fresh = ops.filter(op => !alreadyStored.has(op.id))

      const applied: AppendedOp[] = []
      // Overwritten by the RETURNING below when there is anything fresh; the
      // read value is what a fully-duplicate batch is re-acked against.
      let currentSeq = board.currentSeq

      if (fresh.length > 0) {
        /*
         * ONE statement claims a contiguous BLOCK of sequence numbers for the
         * whole batch and adjusts `objectCount` in the same breath.
         *
         * `objectCount` is incremented IN SQL rather than computed from the row
         * read above, and that is the same bug as SELECT MAX(seq) wearing a
         * different hat: two concurrent appends both read objectCount = 40,
         * both write 41, and the board loses an object from its count on every
         * collision. Forty concurrent batches in the test lost eleven.
         *
         * GREATEST(0, …) because a DELETE for an object created before the
         * counter existed would otherwise drive it negative.
         */
        const delta =
          fresh.filter(op => op.type === 'CREATE').length -
          fresh.filter(op => op.type === 'DELETE').length

        const [updated] = await tx.$queryRaw<{ currentSeq: number; objectCount: number }[]>`
          UPDATE "Board"
          SET "currentSeq" = "currentSeq" + ${fresh.length},
              "objectCount" = GREATEST(0, "objectCount" + ${delta}),
              "lastActivityAt" = NOW()
          WHERE "id" = ${boardId}
          RETURNING "currentSeq", "objectCount"
        `
        if (!updated) {
          throw new AuthError(ERROR_CODES.NOT_FOUND, 'Board not found', 404)
        }

        /*
         * The cap is checked on the value the database actually produced, and
         * throwing here rolls the whole transaction back — including the
         * increment. Checking beforehand would be a read-then-decide race in
         * exactly the way the increment above avoids.
         */
        if (updated.objectCount > MAX_OBJECTS_PER_BOARD) {
          throw new AuthError(
            ERROR_CODES.VALIDATION_FAILED,
            `A board cannot exceed ${MAX_OBJECTS_PER_BOARD} objects`,
            422,
          )
        }

        currentSeq = updated.currentSeq
        const firstSeq = currentSeq - fresh.length + 1

        const rows: Prisma.OperationCreateManyInput[] = fresh.map((op, i) => ({
          id: op.id,
          boardId,
          seq: firstSeq + i,
          type: op.type,
          objectId: op.objectId,
          payload: op.payload as Prisma.InputJsonValue,
          actorId: actor.userId ?? null,
          actorGuest: actor.guestId ?? null,
        }))

        await tx.operation.createMany({ data: rows })

        for (const [i, op] of fresh.entries()) {
          applied.push({
            id: op.id,
            seq: firstSeq + i,
            type: op.type,
            objectId: op.objectId,
            payload: op.payload,
            duplicate: false,
          })
        }
      }

      // Re-acked duplicates, carrying the seq they were originally given.
      for (const op of ops) {
        const stored = alreadyStored.get(op.id)
        if (!stored) continue
        applied.push({
          id: stored.id,
          seq: stored.seq,
          type: stored.type,
          objectId: stored.objectId,
          payload: stored.payload,
          duplicate: true,
        })
      }

      applied.sort((a, b) => a.seq - b.seq)
      return { applied, currentSeq }
    })
  }

  /**
   * Ops after a sequence number — the reconnect gap-fill path (E-15) and the
   * tail half of the snapshot load.
   */
  async since(boardId: string, sinceSeq: number, limit = 1000): Promise<AppendedOp[]> {
    const rows = await this.db.operation.findMany({
      where: { boardId, seq: { gt: sinceSeq } },
      orderBy: { seq: 'asc' },
      take: Math.min(limit, 5000),
      select: { id: true, seq: true, type: true, objectId: true, payload: true },
    })
    return rows.map(row => ({ ...row, duplicate: false }))
  }

  async currentSeq(boardId: string): Promise<number> {
    const board = await this.db.board.findUnique({
      where: { id: boardId },
      select: { currentSeq: true },
    })
    return board?.currentSeq ?? 0
  }
}

export const opService = new OpService()
