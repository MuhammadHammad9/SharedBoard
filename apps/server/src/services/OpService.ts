import type { Prisma, PrismaClient } from '@prisma/client'
import {
  ERROR_CODES,
  MAX_OBJECTS_PER_BOARD,
  OBJECT_TYPES,
  UpdatePayloadByType,
  type ClientOp,
  type ObjectType,
} from '@coboard/shared'
import { AuthError } from './AuthService.js'
import { prisma as defaultPrisma } from '../lib/prisma.js'
import { opPersistSeconds } from '../lib/metrics.js'
import { isStorageImageUrl } from '../lib/s3.js'

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

/**
 * An op refused by the server-side checks that need the database: the
 * target's type, the image URL, the op id's uniqueness. Each one is an
 * INVALID_OP decision for THAT op; the rest of its batch still persists, the
 * same per-op posture as the schema check (TRD §5.4 step 2).
 */
export interface RejectedOp {
  id: string
  reason: string
}

const isObjectType = (value: unknown): value is ObjectType =>
  typeof value === 'string' && (OBJECT_TYPES as readonly string[]).includes(value)

export interface AppendResult {
  applied: AppendedOp[]
  /** Refused by the board-dependent checks; never persisted, never acked. */
  rejected: RejectedOp[]
  currentSeq: number
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
  ): Promise<AppendResult> {
    if (ops.length === 0) {
      const board = await this.db.board.findUnique({
        where: { id: boardId },
        select: { currentSeq: true },
      })
      return { applied: [], rejected: [], currentSeq: board?.currentSeq ?? 0 }
    }

    // TRD §15.4 "op persist latency": the whole transaction, including the
    // wait for the board's row lock, because that wait is what grows when one
    // board is hot. Failed transactions are timed too; a slow rollback is
    // still a slow persist.
    const endTimer = opPersistSeconds.startTimer()
    try {
      return await this.persist(boardId, ops, actor)
    } finally {
      endTimer()
    }
  }

  private persist(
    boardId: string,
    ops: readonly ClientOp[],
    actor: Actor,
  ): Promise<AppendResult> {
    return this.db.$transaction(async tx => {
      /*
       * FOR UPDATE: the board's row lock is taken FIRST, not at the seq
       * increment below. The type lookup in `refuse` reads which CREATE an
       * UPDATE will merge onto, and that answer must not change between the
       * read and the seq claim — a concurrent DELETE + re-CREATE of the same
       * object id as a different type would otherwise slip in between. Same
       * lock as before, held from a few statements earlier; appends to other
       * boards are unaffected.
       */
      const [board] = await tx.$queryRaw<
        { id: string; deletedAt: Date | null; currentSeq: number }[]
      >`
        SELECT "id", "deletedAt", "currentSeq" FROM "Board"
        WHERE "id" = ${boardId}
        FOR UPDATE
      `
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
      /*
       * Looked up across ALL boards, because `Operation.id` is a GLOBAL
       * primary key. An id already stored on a DIFFERENT board is not a retry
       * of this op — re-acking it would hand back another board's seq — and
       * inserting it fails with P2002, which used to roll back the whole batch
       * as a "transient" failure the client then retried forever (finding 13).
       */
      const existing = await tx.operation.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          boardId: true,
          seq: true,
          type: true,
          objectId: true,
          payload: true,
        },
      })
      const alreadyStored = new Map(
        existing.filter(row => row.boardId === boardId).map(row => [row.id, row]),
      )
      const rejected = new Map<string, string>()
      for (const row of existing) {
        if (row.boardId !== boardId) rejected.set(row.id, 'Operation id already used')
      }

      // The same id twice in one batch: two different ops claiming one
      // idempotency key. Neither can be stored under it, so both are refused.
      const counts = new Map<string, number>()
      for (const op of ops) counts.set(op.id, (counts.get(op.id) ?? 0) + 1)
      for (const [id, count] of counts) {
        if (count > 1 && !alreadyStored.has(id)) {
          rejected.set(id, 'Duplicate operation id in batch')
        }
      }

      const candidates = ops.filter(
        op => !alreadyStored.has(op.id) && !rejected.has(op.id),
      )
      for (const [id, reason] of await this.refuse(tx, boardId, candidates)) {
        rejected.set(id, reason)
      }
      const fresh = candidates.filter(op => !rejected.has(op.id))

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

        const [updated] = await tx.$queryRaw<
          { currentSeq: number; objectCount: number }[]
        >`
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

      // Re-acked duplicates, carrying the seq they were originally given. Once
      // each, however many times the batch repeats the id.
      const reacked = new Set<string>()
      for (const op of ops) {
        const stored = alreadyStored.get(op.id)
        if (!stored || reacked.has(op.id)) continue
        reacked.add(op.id)
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
      return {
        applied,
        rejected: [...rejected].map(([id, reason]) => ({ id, reason })),
        currentSeq,
      }
    })
  }

  /**
   * The checks the shared schema cannot make, because they depend on what is
   * already on the board — finding 1 and finding 19.
   *
   * ┌──────────────────────────────────────────────────────────────────────────┐
   * │  AN UPDATE IS JUDGED AGAINST ITS TARGET'S TYPE.                          │
   * │                                                                          │
   * │  The wire schema accepts any key ANY object type has. `{color:'#123456'}`│
   * │  is a fine stroke colour and an invalid sticky colour (frozen palette,   │
   * │  R-UI-014); `{url: …}` on a rectangle would make it half an image. So    │
   * │  each UPDATE is re-checked against `UpdatePayloadByType[type]`, where     │
   * │  `type` is the type of the latest CREATE of that object in seq order —   │
   * │  exactly the object the fold will merge it onto.                         │
   * │                                                                          │
   * │  Equivalent to merging and re-parsing with BoardObjectSchema, because    │
   * │  the object schemas have no cross-field rules (see op.ts) and the stored │
   * │  object was itself validated on the way in. It costs one indexed query  │
   * │  per BATCH, where the merge would mean materialising the object from    │
   * │  snapshot plus tail on every op — not affordable at 100 ops/s.          │
   * └──────────────────────────────────────────────────────────────────────────┘
   *
   * An UPDATE to an object never created on this board is let through: the
   * fold drops it (delete beats update, R-CONV-004), so it can change nothing,
   * and refusing it would roll back a client whose CREATE was nacked a moment
   * earlier for an unrelated reason.
   */
  private async refuse(
    tx: Prisma.TransactionClient,
    boardId: string,
    ops: readonly ClientOp[],
  ): Promise<Map<string, string>> {
    const refused = new Map<string, string>()

    const updated = [
      ...new Set(ops.filter(op => op.type === 'UPDATE').map(op => op.objectId)),
    ]
    const typeOf = new Map<string, ObjectType>()
    if (updated.length > 0) {
      const rows = await tx.$queryRaw<{ objectId: string; type: string | null }[]>`
        SELECT DISTINCT ON ("objectId") "objectId", "payload"->>'type' AS "type"
        FROM "Operation"
        WHERE "boardId" = ${boardId}
          AND "objectId" = ANY(${updated}::text[])
          AND "type" = 'CREATE'
        ORDER BY "objectId", "seq" DESC
      `
      for (const row of rows) {
        if (isObjectType(row.type)) typeOf.set(row.objectId, row.type)
      }
    }

    // In batch order, so an UPDATE following a CREATE in the same batch is
    // judged against that CREATE.
    for (const op of ops) {
      if (op.type === 'CREATE') {
        if (op.payload.type === 'image' && !isStorageImageUrl(op.payload.url)) {
          refused.set(op.id, 'Image url is not an upload')
          continue
        }
        typeOf.set(op.objectId, op.payload.type)
        continue
      }
      if (op.type !== 'UPDATE') continue

      const type = typeOf.get(op.objectId)
      if (!type) continue
      const parsed = UpdatePayloadByType[type].safeParse(op.payload)
      if (!parsed.success) {
        refused.set(op.id, `Invalid update for a ${type}`)
        continue
      }
      const url = (op.payload as { url?: unknown }).url
      if (typeof url === 'string' && !isStorageImageUrl(url)) {
        refused.set(op.id, 'Image url is not an upload')
      }
    }
    return refused
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
