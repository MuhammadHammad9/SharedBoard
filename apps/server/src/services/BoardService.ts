import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import {
  BOARD_CARD_MEMBERS,
  BOARD_NAME_MAX,
  ERROR_CODES,
  TRASH_RETENTION_DAYS,
  type BoardMemberPreview,
  type BoardSummary,
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

export type { BoardSummary }

type BoardRow = Prisma.BoardGetPayload<{
  include: {
    owner: { select: { displayName: true; avatarUrl: true } }
    members: { select: { role: true } }
  }
}>

/** The avatar row of each board — FLOWS §6.2. See `BoardService.memberPreviews`. */
interface MemberPreviews {
  members: BoardMemberPreview[]
  memberCount: number
}

const NO_MEMBERS: MemberPreviews = { members: [], memberCount: 0 }

function daysUntilPurge(deletedAt: Date): number {
  const elapsedMs = Date.now() - deletedAt.getTime()
  const remaining = TRASH_RETENTION_DAYS - elapsedMs / 86_400_000
  return Math.max(0, Math.ceil(remaining))
}

function toSummary(
  row: BoardRow,
  userId: string,
  previews: MemberPreviews = NO_MEMBERS,
): BoardSummary {
  const myRole: Role =
    row.ownerId === userId ? 'OWNER' : ((row.members[0]?.role ?? 'VIEWER') as Role)

  return {
    id: row.id,
    name: row.name,
    ownerId: row.ownerId,
    ownerName: row.owner.displayName,
    ownerAvatarUrl: row.owner.avatarUrl,
    myRole,
    thumbnailUrl: row.thumbnailUrl,
    objectCount: row.objectCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
    ...(row.deletedAt ? { daysUntilPurge: daysUntilPurge(row.deletedAt) } : {}),
    members: previews.members,
    memberCount: previews.memberCount,
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
      owner: { select: { displayName: true, avatarUrl: true } },
      members: { where: { userId }, select: { role: true }, take: 1 },
    } as const
  }

  /**
   * The card avatar row for a whole PAGE of boards, in ONE query — FLOWS §6.2,
   * FR-BOARD-002 ("owner avatar, and up to 4 collaborator avatars with a +N
   * overflow").
   *
   * Not a Prisma `include`: a nested `take` per parent is not something
   * Postgres can be asked for through it, so the include would read EVERY
   * membership of every listed board — a board shared by link with two
   * hundred guests would ship two hundred rows to draw four circles. A window
   * function ranks each board's members and keeps the first four, and the
   * same pass counts them all for the "+N".
   *
   * The owner is excluded (the card shows them separately), and so is a
   * guest's id: the preview carries the membership row's id instead (D-1).
   */
  private async memberPreviews(
    boardIds: readonly string[],
  ): Promise<Map<string, MemberPreviews>> {
    const out = new Map<string, MemberPreviews>()
    if (boardIds.length === 0) return out

    const rows = await this.db.$queryRaw<
      Array<{
        boardId: string
        id: string
        displayName: string | null
        avatarUrl: string | null
        guest: boolean
        total: bigint
      }>
    >`
      SELECT "boardId", id, "displayName", "avatarUrl", guest, total
      FROM (
        SELECT
          m."boardId",
          m.id,
          COALESCE(u."displayName", m."guestName") AS "displayName",
          u."avatarUrl",
          (m."userId" IS NULL) AS guest,
          ROW_NUMBER() OVER (
            PARTITION BY m."boardId" ORDER BY m."createdAt", m.id
          ) AS rank,
          COUNT(*) OVER (PARTITION BY m."boardId") AS total
        FROM "BoardMember" m
        JOIN "Board" b ON b.id = m."boardId"
        LEFT JOIN "User" u ON u.id = m."userId"
        WHERE m."boardId" IN (${Prisma.join(boardIds)})
          AND (m."userId" IS NULL OR m."userId" <> b."ownerId")
      ) ranked
      WHERE rank <= ${BOARD_CARD_MEMBERS}
      ORDER BY "boardId", rank
    `

    for (const row of rows) {
      const entry = out.get(row.boardId) ?? {
        members: [],
        memberCount: Number(row.total),
      }
      entry.members.push({
        id: row.id,
        displayName: row.displayName ?? '',
        avatarUrl: row.avatarUrl,
        guest: row.guest,
      })
      out.set(row.boardId, entry)
    }
    return out
  }

  /** Rows → summaries, with the avatar rows filled in by one extra query. */
  private async summaries(rows: BoardRow[], userId: string): Promise<BoardSummary[]> {
    const previews = await this.memberPreviews(rows.map(row => row.id))
    return rows.map(row => toSummary(row, userId, previews.get(row.id)))
  }

  private async summary(row: BoardRow, userId: string): Promise<BoardSummary> {
    return (await this.summaries([row], userId))[0]!
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
    return this.summary(row, userId)
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
    /*
     * D-34: starring is FR-BOARD-008 [P2] and has no model, so nothing is
     * starred and the Starred tab is EMPTY — which the dashboard renders as
     * the filter-empty state ("No boards match that filter" + Clear filter),
     * never as "Nothing here yet". Returning every board here, as Phase 8 did,
     * made the tab claim the user had starred everything.
     */
    if (query.filter === 'starred') return { boards: [], nextCursor: null }

    const scope: Prisma.BoardWhereInput =
      query.filter === 'owned'
        ? { ownerId: userId }
        : query.filter === 'shared'
          ? { ownerId: { not: userId }, members: { some: { userId } } }
          : { OR: [{ ownerId: userId }, { members: { some: { userId } } }] }

    const where: Prisma.BoardWhereInput = {
      AND: [
        scope,
        { deletedAt: null },
        ...(query.q
          ? [{ name: { contains: query.q, mode: 'insensitive' as const } }]
          : []),
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

    return { boards: await this.summaries(page, userId), nextCursor }
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
    const field =
      query.sort === 'name'
        ? 'name'
        : query.sort === 'created'
          ? 'createdAt'
          : 'lastActivityAt'
    const value: string | Date =
      query.sort === 'name' ? decoded.value : new Date(decoded.value)
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
    return this.summary(row, userId)
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
    return this.summary(row, userId)
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
    return this.summary(row, userId)
  }

  async restore(boardId: string, userId: string): Promise<BoardSummary> {
    const row = await this.db.board.update({
      where: { id: boardId },
      data: { deletedAt: null },
      include: this.include(userId),
    })
    return this.summary(row, userId)
  }

  async listTrash(userId: string): Promise<BoardSummary[]> {
    const rows = await this.db.board.findMany({
      where: { ownerId: userId, deletedAt: { not: null } },
      include: this.include(userId),
      orderBy: [{ deletedAt: 'desc' }, { id: 'asc' }],
      take: 200,
    })
    return this.summaries(rows, userId)
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
  async purgeExpiredTrash(
    now: Date = new Date(),
    /** Their thumbnails' URLs, for the caller to delete from storage. */
    onPurged?: (thumbnailUrls: string[]) => Promise<void>,
  ): Promise<number> {
    const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * 86_400_000)
    const expired = await this.db.board.findMany({
      where: { deletedAt: { lt: cutoff } },
      select: { id: true, thumbnailUrl: true },
    })
    if (expired.length === 0) return 0
    const { count } = await this.db.board.deleteMany({
      where: { id: { in: expired.map(b => b.id) }, deletedAt: { lt: cutoff } },
    })
    await onPurged?.(expired.flatMap(b => (b.thumbnailUrl ? [b.thumbnailUrl] : [])))
    return count
  }

  async thumbnailOf(boardId: string): Promise<string | null> {
    const row = await this.db.board.findUnique({
      where: { id: boardId },
      select: { thumbnailUrl: true },
    })
    return row?.thumbnailUrl ?? null
  }
}

export const boardService = new BoardService()
