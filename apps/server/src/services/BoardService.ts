import { randomUUID } from 'node:crypto'
import type { Prisma, PrismaClient } from '@prisma/client'
import {
  BOARD_NAME_MAX,
  ERROR_CODES,
  TRASH_RETENTION_DAYS,
  type ListBoardsQuery,
  type Role,
} from '@coboard/shared'
import { AuthError } from './AuthService.js'
import { prisma as defaultPrisma } from '../lib/prisma.js'

/**
 * Boards — FR-BOARD-001…007, TRD §4.2.
 *
 * Everything here is metadata. The board's *content* is the op log and lives
 * in `OpService`; the split matters because the dashboard lists 24 boards
 * without touching a single operation row, and a board with 40,000 ops costs
 * the same to list as an empty one.
 */

export const BOARDS_PAGE_SIZE = 24

export interface BoardSummary {
  id: string
  name: string
  ownerId: string
  ownerName: string
  myRole: Role
  thumbnailUrl: string | null
  objectCount: number
  createdAt: string
  updatedAt: string
  lastActivityAt: string
  deletedAt: string | null
  /** Days until Trash purges it. Only meaningful when `deletedAt` is set. */
  daysUntilPurge?: number
}

type BoardRow = Prisma.BoardGetPayload<{
  include: {
    owner: { select: { displayName: true } }
    members: { select: { role: true } }
  }
}>

function daysUntilPurge(deletedAt: Date): number {
  const elapsedMs = Date.now() - deletedAt.getTime()
  const remaining = TRASH_RETENTION_DAYS - elapsedMs / 86_400_000
  return Math.max(0, Math.ceil(remaining))
}

function toSummary(row: BoardRow, userId: string): BoardSummary {
  const myRole: Role =
    row.ownerId === userId ? 'OWNER' : ((row.members[0]?.role ?? 'VIEWER') as Role)

  return {
    id: row.id,
    name: row.name,
    ownerId: row.ownerId,
    ownerName: row.owner.displayName,
    myRole,
    thumbnailUrl: row.thumbnailUrl,
    objectCount: row.objectCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
    ...(row.deletedAt ? { daysUntilPurge: daysUntilPurge(row.deletedAt) } : {}),
  }
}

/**
 * The cursor is an opaque base64 of the sort key plus the id.
 *
 * The id is in there as a tiebreaker, and that is not cosmetic: two boards
 * created in the same millisecond — which `pnpm db:seed` produces routinely —
 * would otherwise make the page boundary ambiguous, and the user would see one
 * board twice and never see the other.
 */
function encodeCursor(value: string, id: string): string {
  return Buffer.from(`${value}|${id}`).toString('base64url')
}

function decodeCursor(cursor: string): { value: string; id: string } | null {
  try {
    const [value, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|')
    if (!value || !id) return null
    return { value, id }
  } catch {
    return null
  }
}

export class BoardService {
  constructor(private readonly db: PrismaClient = defaultPrisma) {}

  /**
   * The membership row is scoped to the CALLER, not to the board.
   *
   * Including every member and reading the first would return whichever row
   * Postgres happened to hand back — in practice the owner's, since it is
   * inserted first. Every shared board would then report `myRole: 'OWNER'`,
   * and the dashboard would offer rename and delete on a board belonging to
   * someone else. The server would refuse them, so it is not a security hole,
   * but it is a UI that lies.
   */
  private include(userId: string) {
    return {
      owner: { select: { displayName: true } },
      members: { where: { userId }, select: { role: true }, take: 1 },
    } as const
  }

  /**
   * FR-BOARD-001. The owner gets a membership row at creation time.
   *
   * The row is redundant with `ownerId` for authorization — `PermissionService`
   * short-circuits on ownership — but it is what makes the members list, the
   * share modal and Phase 12's role changes able to treat every participant
   * uniformly instead of special-casing one of them everywhere.
   */
  async create(userId: string, name?: string): Promise<BoardSummary> {
    const row = await this.db.board.create({
      data: {
        name: name?.trim() || 'Untitled board',
        ownerId: userId,
        members: { create: { userId, role: 'OWNER' } },
      },
      include: this.include(userId),
    })
    return toSummary(row, userId)
  }

  /**
   * FR-BOARD-002. One page of the dashboard.
   *
   * Keyset pagination, not `skip`/`take`. An offset page 5 re-scans the first
   * 96 rows every time, and — worse for a list sorted by last activity — a
   * board edited between two page requests shifts the window and the user
   * silently skips a row.
   */
  async list(
    userId: string,
    query: ListBoardsQuery,
  ): Promise<{ boards: BoardSummary[]; nextCursor: string | null }> {
    const scope: Prisma.BoardWhereInput =
      query.filter === 'owned'
        ? { ownerId: userId }
        : query.filter === 'shared'
          ? { ownerId: { not: userId }, members: { some: { userId } } }
          : // 'starred' has no model until Phase 12 (there is no Star table yet),
          // so it resolves to the same set as 'all' rather than returning an
          // empty list that would read as "you have no boards".
          { OR: [{ ownerId: userId }, { members: { some: { userId } } }] }

    const where: Prisma.BoardWhereInput = {
      AND: [
        scope,
        { deletedAt: null },
        ...(query.q ? [{ name: { contains: query.q, mode: 'insensitive' as const } }] : []),
        ...(this.cursorFilter(query, query.cursor) ?? []),
      ],
    }

    const rows = await this.db.board.findMany({
      where,
      include: this.include(userId),
      orderBy: this.orderBy(query.sort),
      // One extra row is the cheapest possible "is there a next page?" — the
      // alternative is a second COUNT query over the same predicate.
      take: BOARDS_PAGE_SIZE + 1,
    })

    const page = rows.slice(0, BOARDS_PAGE_SIZE)
    const last = page.at(-1)
    const nextCursor =
      rows.length > BOARDS_PAGE_SIZE && last
        ? encodeCursor(this.sortValue(last, query.sort), last.id)
        : null

    return { boards: page.map(row => toSummary(row, userId)), nextCursor }
  }

  private orderBy(sort: ListBoardsQuery['sort']): Prisma.BoardOrderByWithRelationInput[] {
    if (sort === 'name') return [{ name: 'asc' }, { id: 'asc' }]
    if (sort === 'created') return [{ createdAt: 'desc' }, { id: 'asc' }]
    return [{ lastActivityAt: 'desc' }, { id: 'asc' }]
  }

  private sortValue(row: BoardRow, sort: ListBoardsQuery['sort']): string {
    if (sort === 'name') return row.name
    if (sort === 'created') return row.createdAt.toISOString()
    return row.lastActivityAt.toISOString()
  }

  private cursorFilter(
    query: ListBoardsQuery,
    cursor: string | undefined,
  ): Prisma.BoardWhereInput[] | null {
    if (!cursor) return null
    const decoded = decodeCursor(cursor)
    // A malformed cursor returns page one rather than an error. It is almost
    // always a stale bookmark, and a 422 on a URL the user pasted helps nobody.
    if (!decoded) return null

    const asc = query.sort === 'name'
    const field = query.sort === 'name' ? 'name' : query.sort === 'created' ? 'createdAt' : 'lastActivityAt'
    const value: string | Date = query.sort === 'name' ? decoded.value : new Date(decoded.value)
    if (value instanceof Date && Number.isNaN(value.getTime())) return null

    const beyond = asc ? { gt: value } : { lt: value }
    return [
      {
        OR: [
          { [field]: beyond } as Prisma.BoardWhereInput,
          {
            AND: [
              { [field]: value } as Prisma.BoardWhereInput,
              { id: { gt: decoded.id } },
            ],
          },
        ],
      },
    ]
  }

  async get(boardId: string, userId: string): Promise<BoardSummary> {
    const row = await this.db.board.findUnique({
      where: { id: boardId },
      include: this.include(userId),
    })
    if (!row) throw new AuthError(ERROR_CODES.NOT_FOUND, 'Board not found', 404)
    return toSummary(row, userId)
  }

  /** FR-BOARD-003. */
  async rename(boardId: string, userId: string, name: string): Promise<BoardSummary> {
    const trimmed = name.trim()
    if (trimmed.length === 0 || trimmed.length > BOARD_NAME_MAX) {
      throw new AuthError(ERROR_CODES.VALIDATION_FAILED, 'Invalid board name', 422, {
        field: 'name',
      })
    }
    const row = await this.db.board.update({
      where: { id: boardId },
      data: { name: trimmed },
      include: this.include(userId),
    })
    return toSummary(row, userId)
  }

  /**
   * FR-BOARD-005 — soft delete. The board goes to Trash for 30 days.
   *
   * Nothing is destroyed here, which is what makes "Undo" on the toast a
   * single UPDATE rather than a restore from a backup.
   */
  async trash(boardId: string, userId: string): Promise<BoardSummary> {
    const row = await this.db.board.update({
      where: { id: boardId },
      data: { deletedAt: new Date() },
      include: this.include(userId),
    })
    return toSummary(row, userId)
  }

  async restore(boardId: string, userId: string): Promise<BoardSummary> {
    const row = await this.db.board.update({
      where: { id: boardId },
      data: { deletedAt: null },
      include: this.include(userId),
    })
    return toSummary(row, userId)
  }

  async listTrash(userId: string): Promise<BoardSummary[]> {
    const rows = await this.db.board.findMany({
      where: { ownerId: userId, deletedAt: { not: null } },
      include: this.include(userId),
      orderBy: [{ deletedAt: 'desc' }, { id: 'asc' }],
      take: 200,
    })
    return rows.map(row => toSummary(row, userId))
  }

  /**
   * FR-BOARD-006 — permanent delete, gated on an exact name match.
   *
   * The confirmation is compared trimmed but case-SENSITIVELY. This is the one
   * irreversible action in the product: every op, every snapshot and every
   * membership goes with the row, by cascade. Making the user type the name
   * exactly is the friction that stops a mis-click from destroying a
   * colleague's afternoon.
   */
  async destroy(boardId: string, userId: string, confirmName: string): Promise<void> {
    const board = await this.db.board.findUnique({
      where: { id: boardId },
      select: { name: true },
    })
    if (!board) throw new AuthError(ERROR_CODES.NOT_FOUND, 'Board not found', 404)

    if (confirmName.trim() !== board.name) {
      throw new AuthError(
        ERROR_CODES.CONFIRMATION_MISMATCH,
        'The name does not match',
        422,
        { field: 'confirmName' },
      )
    }
    await this.db.board.delete({ where: { id: boardId } })
  }

  /**
   * FR-BOARD-007 — duplicate.
   *
   * Copies the CONTENT and nothing else: the new board has no members beyond
   * its owner and no share links. Carrying the member list over would silently
   * re-share a board with people the duplicating user may have meant to
   * exclude — a copy is a new document, not a fork of an access list.
   *
   * The content is copied as ONE `CREATE` op per surviving object rather than
   * by replaying the source log. Replaying would reproduce every intermediate
   * edit and every deleted object's history, so a board that had been drawn on
   * for an hour would duplicate as an hour of ops instead of its 40 objects.
   */
  async duplicate(
    boardId: string,
    userId: string,
    materialise: (boardId: string) => Promise<{ objects: unknown[] }>,
  ): Promise<BoardSummary> {
    const source = await this.db.board.findUnique({
      where: { id: boardId },
      select: { name: true },
    })
    if (!source) throw new AuthError(ERROR_CODES.NOT_FOUND, 'Board not found', 404)

    const { objects } = await materialise(boardId)
    const name = `${source.name} (copy)`.slice(0, BOARD_NAME_MAX)

    return this.db.$transaction(async tx => {
      const row = await tx.board.create({
        data: {
          name,
          ownerId: userId,
          objectCount: objects.length,
          currentSeq: objects.length,
          members: { create: { userId, role: 'OWNER' } },
        },
        include: this.include(userId),
      })

      if (objects.length > 0) {
        /*
         * Fresh object ids. The copy is a separate document, and reusing the
         * source's ids would mean a user with both boards open holds two
         * different objects under one id — harmless today, and exactly the
         * kind of assumption Phase 9's cross-board presence code would break
         * on.
         */
        await tx.operation.createMany({
          data: objects.map((object, i) => {
            const objectId = randomUUID()
            return {
              id: randomUUID(),
              boardId: row.id,
              seq: i + 1,
              type: 'CREATE' as const,
              objectId,
              payload: { ...(object as object), id: objectId } as Prisma.InputJsonValue,
              actorId: userId,
            }
          }),
        })
      }

      return toSummary(row, userId)
    })
  }

  /**
   * Purge boards whose 30 days are up — FR-BOARD-005.
   *
   * Called by a scheduled job, and exposed here so a test can call it directly
   * with a clock it controls rather than waiting a month.
   */
  async purgeExpiredTrash(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * 86_400_000)
    const { count } = await this.db.board.deleteMany({
      where: { deletedAt: { lt: cutoff } },
    })
    return count
  }
}

export const boardService = new BoardService()
