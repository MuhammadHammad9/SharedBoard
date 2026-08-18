import type { Prisma, PrismaClient } from '@prisma/client'
import {
  SNAPSHOT_INTERVAL_OPS,
  SNAPSHOT_RETENTION,
  type BoardObject,
} from '@coboard/shared'
import { logger } from '../lib/logger.js'
import { prisma as defaultPrisma } from '../lib/prisma.js'

/**
 * Snapshots — TRD §3.4, FR-SYNC-009.
 *
 * The op log is the source of truth, and the price of that is replay cost: a
 * board with 50,000 ops would mean reading and folding 50,000 rows on every
 * load. A snapshot is materialised state at a sequence number, so a load reads
 * ONE snapshot plus the ops after it — bounded by the snapshot interval rather
 * than by the board's whole history.
 *
 * The board's state is therefore never stored anywhere authoritative. It is
 * always `snapshot ⊕ tail`, and the snapshot is a cache that can be deleted at
 * any time without losing data. That property is worth protecting: the moment
 * something writes to a snapshot without a corresponding op, the log stops
 * being the truth.
 */

export interface MaterialisedBoard {
  objects: BoardObject[]
  /** The sequence number this state is current as of. */
  seq: number
  /** Whether a stored snapshot was used, for the load-path metric. */
  fromSnapshot: boolean
  /** How many ops had to be folded on top. */
  replayed: number
}

/** The fold. Exported because the client applies the identical rules. */
interface OpRow {
  seq: number
  type: 'CREATE' | 'UPDATE' | 'DELETE'
  objectId: string
  payload: unknown
}

/**
 * Fold a sequence of ops over a starting state.
 *
 * `Map` preserves insertion order, which is NOT the render order — z-order
 * comes from each object's fractional `zIndex` and is the client's business.
 * Relying on Map order here would produce a board that renders differently
 * depending on whether it loaded from a snapshot or from a replay, which is
 * precisely the divergence class the `?debug=1` hash exists to catch.
 */
export function foldOps(
  base: Map<string, BoardObject>,
  ops: readonly OpRow[],
): Map<string, BoardObject> {
  for (const op of ops) {
    if (op.type === 'CREATE') {
      base.set(op.objectId, op.payload as BoardObject)
    } else if (op.type === 'DELETE') {
      base.delete(op.objectId)
    } else {
      const existing = base.get(op.objectId)
      /*
       * R-CONV-002: UPDATE payloads are PARTIAL, and the merge replaces only
       * the fields present. Treating them as a whole object here would turn a
       * concurrent "move" and "recolour" into a lost update on load, even
       * though the log recorded both correctly.
       *
       * An UPDATE for an object that is not present is DROPPED, not
       * resurrected as a partial: delete beats update (R-CONV-004), and the
       * op log can legitimately contain an update that a later delete
       * outlived, or one whose object never existed after a nack.
       */
      if (!existing) continue
      base.set(op.objectId, {
        ...existing,
        ...(op.payload as Partial<BoardObject>),
      } as BoardObject)
    }
  }
  return base
}

export class SnapshotService {
  constructor(private readonly db: PrismaClient = defaultPrisma) {}

  /**
   * The board load path — FLOWS §2.3 step 5.
   *
   * Latest snapshot at or below `upToSeq`, then every op after it. When no
   * snapshot exists — every board under 500 ops — this is a plain full replay,
   * which is exactly right at that size.
   */
  async materialise(boardId: string, upToSeq?: number): Promise<MaterialisedBoard> {
    const snapshot = await this.db.snapshot.findFirst({
      where: { boardId, ...(upToSeq !== undefined ? { seq: { lte: upToSeq } } : {}) },
      orderBy: { seq: 'desc' },
      select: { seq: true, state: true },
    })

    const base = new Map<string, BoardObject>()
    if (snapshot) {
      const stored = snapshot.state as unknown as { objects?: BoardObject[] }
      for (const object of stored.objects ?? []) base.set(object.id, object)
    }

    const fromSeq = snapshot?.seq ?? 0
    const ops = await this.db.operation.findMany({
      where: {
        boardId,
        seq: { gt: fromSeq, ...(upToSeq !== undefined ? { lte: upToSeq } : {}) },
      },
      orderBy: { seq: 'asc' },
      select: { seq: true, type: true, objectId: true, payload: true },
    })

    const objects = foldOps(base, ops as OpRow[])
    const seq = ops.at(-1)?.seq ?? fromSeq

    return {
      objects: [...objects.values()],
      seq,
      fromSnapshot: snapshot !== null,
      replayed: ops.length,
    }
  }

  /**
   * Write a snapshot if the board has moved on far enough since the last one.
   *
   * ┌──────────────────────────────────────────────────────────────────────┐
   * │  This is deliberately OFF the request path.                          │
   * │                                                                      │
   * │  Materialising 10,000 objects and writing a JSON blob takes tens of  │
   * │  milliseconds. Doing it inside the op append that happened to be the │
   * │  500th would make one unlucky user's stroke visibly slower than the  │
   * │  499 before it — and PRD G-3 budgets 16 ms input-to-pixel. The       │
   * │  caller fires this and does not await it.                            │
   * └──────────────────────────────────────────────────────────────────────┘
   *
   * Failure is logged and swallowed for the same reason: a snapshot is a
   * cache. If writing it fails, the next load replays a few hundred more ops
   * and nobody notices. Propagating the error would fail an op that was
   * already durably persisted and acknowledged.
   */
  async maybeSnapshot(boardId: string): Promise<boolean> {
    try {
      const [board, latest] = await Promise.all([
        this.db.board.findUnique({
          where: { id: boardId },
          select: { currentSeq: true },
        }),
        this.db.snapshot.findFirst({
          where: { boardId },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        }),
      ])
      if (!board) return false

      const since = board.currentSeq - (latest?.seq ?? 0)
      if (since < SNAPSHOT_INTERVAL_OPS) return false

      await this.snapshotNow(boardId, board.currentSeq)
      return true
    } catch (error) {
      logger.error({ err: error, boardId }, 'snapshot failed')
      return false
    }
  }

  /** Force a snapshot at a sequence number. Used by `maybeSnapshot` and tests. */
  async snapshotNow(boardId: string, seq: number): Promise<void> {
    const { objects } = await this.materialise(boardId, seq)

    await this.db.snapshot.create({
      data: {
        boardId,
        seq,
        state: { objects } as unknown as Prisma.InputJsonValue,
      },
    })

    await this.prune(boardId)
  }

  /**
   * Keep the last N snapshots — SNAPSHOT_RETENTION.
   *
   * More than one is kept because a snapshot is also the recovery point if the
   * newest turns out to have been written from a corrupt fold. One would make
   * that a full replay from op 1; three bounds it.
   */
  private async prune(boardId: string): Promise<void> {
    const keep = await this.db.snapshot.findMany({
      where: { boardId },
      orderBy: { seq: 'desc' },
      take: SNAPSHOT_RETENTION,
      select: { id: true },
    })
    await this.db.snapshot.deleteMany({
      where: { boardId, id: { notIn: keep.map(s => s.id) } },
    })
  }
}

export const snapshotService = new SnapshotService()
