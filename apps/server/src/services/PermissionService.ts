import type { PrismaClient } from '@prisma/client'
import { canEdit, ERROR_CODES, type Role } from '@coboard/shared'
import { AuthError } from './AuthService.js'
import { prisma as defaultPrisma } from '../lib/prisma.js'

/**
 * The one place that answers "may this person do this to this board?" —
 * R-SEC-001, R-SEC-002, TRD §11.2.
 *
 * It exists as a service rather than as middleware because Phase 9's socket
 * gateway has no Express request to hang middleware on, and the rule must be
 * identical on both paths. A permission check duplicated across REST and
 * WebSocket is a permission check that will diverge — that is the failure
 * `AT-20` is written to catch.
 *
 * The 404-vs-403 distinction below is deliberate and is a security decision,
 * not a nicety. See `resolve`.
 */

export interface Access {
  boardId: string
  role: Role | 'none'
  ownerId: string
  deletedAt: Date | null
  name: string
}

export class PermissionService {
  constructor(private readonly db: PrismaClient = defaultPrisma) {}

  /**
   * What role does `userId` hold on `boardId`?
   *
   * Returns 'none' rather than throwing, so callers that legitimately need to
   * distinguish "no access" from "no board" — the S-11 guest join screen, for
   * one — can. Everything else should use `require*` below.
   */
  async resolve(boardId: string, userId: string | undefined): Promise<Access | null> {
    const board = await this.db.board.findUnique({
      where: { id: boardId },
      select: {
        id: true,
        name: true,
        ownerId: true,
        deletedAt: true,
        members: userId
          ? { where: { userId }, select: { role: true }, take: 1 }
          : { where: { userId: '' }, select: { role: true }, take: 0 },
      },
    })
    if (!board) return null

    let role: Role | 'none' = 'none'
    if (userId && board.ownerId === userId) role = 'OWNER'
    else if (board.members[0]) role = board.members[0].role

    return {
      boardId: board.id,
      name: board.name,
      ownerId: board.ownerId,
      deletedAt: board.deletedAt,
      role,
    }
  }

  /**
   * Require at least read access.
   *
   * A board the caller cannot see answers **404, not 403** — R-SEC-018. A 403
   * confirms the id names a real board, which turns the endpoint into an
   * enumeration oracle, and the S-19 screen must never show the board's name
   * to someone who was refused. "Not found" is the honest answer to a caller
   * for whom the board does not exist.
   */
  async requireRead(boardId: string, userId: string | undefined): Promise<Access> {
    const access = await this.resolve(boardId, userId)
    if (!access || access.role === 'none' || access.deletedAt) {
      throw new AuthError(ERROR_CODES.NOT_FOUND, 'Board not found', 404)
    }
    return access
  }

  /**
   * Require write access.
   *
   * A VIEWER gets 403 here, not 404 — they can already see the board, so
   * hiding its existence buys nothing, and an accurate "you have view access"
   * is what lets S-10 render the read-only banner instead of an error screen.
   */
  async requireEdit(boardId: string, userId: string | undefined): Promise<Access> {
    const access = await this.requireRead(boardId, userId)
    if (!canEdit(access.role as Role)) {
      throw new AuthError(ERROR_CODES.FORBIDDEN, 'View-only access', 403)
    }
    return access
  }

  /**
   * Require ownership: rename, trash, restore, permanent delete, members.
   *
   * Built on `resolve` rather than `requireRead` so it tolerates a
   * soft-deleted board — restore and permanent delete both operate on rows
   * that `requireRead` refuses by design.
   */
  async requireOwner(boardId: string, userId: string | undefined): Promise<Access> {
    const access = await this.resolve(boardId, userId)
    if (!access || access.role === 'none') {
      throw new AuthError(ERROR_CODES.NOT_FOUND, 'Board not found', 404)
    }
    if (access.role !== 'OWNER') {
      throw new AuthError(ERROR_CODES.FORBIDDEN, 'Only the owner can do that', 403)
    }
    return access
  }
}

export const permissionService = new PermissionService()
