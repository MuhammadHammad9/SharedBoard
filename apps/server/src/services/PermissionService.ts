import type { PrismaClient } from '@prisma/client'
import { canEdit, ERROR_CODES, type Role } from '@coboard/shared'
import { AuthError } from './AuthService.js'
import { prisma as defaultPrisma } from '../lib/prisma.js'
import { redis } from '../lib/redis.js'
import { identityKey, userIdentity, type Identity } from '../lib/identity.js'
import { logger } from '../lib/logger.js'

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
  /** Denormalised live object count (D-10) — FLOWS §8.1's "Loading N objects…". */
  objectCount: number
}

/** A user id, or a full identity. A bare string is a user — the pre-guest API. */
export type Actor = Identity | string | undefined

const asIdentity = (actor: Actor): Identity | undefined =>
  typeof actor === 'string' ? userIdentity(actor) : actor

/** How long a resolved role is trusted — TRD §11.2. */
export const ROLE_CACHE_SECONDS = 60

const roleKey = (boardId: string, identity: Identity) =>
  `perm:${boardId}:${identityKey(identity)}`

type CachedRole = Role | 'none' | 'gone'

export class PermissionService {
  constructor(private readonly db: PrismaClient = defaultPrisma) {}

  /**
   * What role does this user or guest hold on `boardId`?
   *
   * Returns 'none' rather than throwing, so callers that legitimately need to
   * distinguish "no access" from "no board" — the S-11 guest join screen, for
   * one — can. Everything else should use `require*` below.
   *
   * A guest holds a role only through a `BoardMember` row, created when they
   * joined through a share link. Turning that link off deletes the row
   * (decision D-3), and the link check here is the belt to that braces: a
   * guest whose link was revoked holds nothing even if a row survived.
   */
  async resolve(boardId: string, actor: Actor): Promise<Access | null> {
    const identity = asIdentity(actor)
    const memberWhere =
      identity?.kind === 'user'
        ? { userId: identity.userId }
        : identity?.kind === 'guest'
          ? { guestId: identity.guestId }
          : null

    const board = await this.db.board.findUnique({
      where: { id: boardId },
      select: {
        id: true,
        name: true,
        ownerId: true,
        deletedAt: true,
        objectCount: true,
        members: memberWhere
          ? {
              where: memberWhere,
              select: { role: true, shareLink: { select: { revokedAt: true } } },
              take: 1,
            }
          : {
              where: { id: '' },
              select: { role: true, shareLink: { select: { revokedAt: true } } },
              take: 0,
            },
      },
    })
    if (!board) return null

    let role: Role | 'none' = 'none'
    const member = board.members[0]
    if (identity?.kind === 'user' && board.ownerId === identity.userId) role = 'OWNER'
    else if (member && !(identity?.kind === 'guest' && member.shareLink?.revokedAt)) {
      role = member.role
    }

    return {
      boardId: board.id,
      name: board.name,
      ownerId: board.ownerId,
      deletedAt: board.deletedAt,
      objectCount: board.objectCount,
      role,
    }
  }

  /**
   * The role, through a 60-second Redis cache — TRD §11.2.
   *
   * This is what the socket checks on EVERY op batch (defect P-1): the role a
   * session was opened with is not trusted, because a member demoted or
   * removed mid-session must stop being able to write at once, not on their
   * next reconnect. `invalidate` is called on every role change, so the cache
   * never serves a stale grant; the TTL only bounds the damage if an
   * invalidation is ever missed.
   *
   * Redis being down is not a reason to refuse every edit: the cache is
   * skipped and the database answers.
   */
  async getRole(boardId: string, actor: Actor): Promise<CachedRole> {
    const identity = asIdentity(actor)
    if (!identity) return 'none'
    const key = roleKey(boardId, identity)

    try {
      const cached = await redis().get(key)
      if (cached) return cached as CachedRole
    } catch (error) {
      logger.warn({ err: error }, 'role cache read failed')
    }

    const access = await this.resolve(boardId, identity)
    const role: CachedRole = !access || access.deletedAt ? 'gone' : access.role

    try {
      await redis().set(key, role, 'EX', ROLE_CACHE_SECONDS)
    } catch (error) {
      logger.warn({ err: error }, 'role cache write failed')
    }
    return role
  }

  /**
   * Forget cached roles: one identity's, or — with no identity — everyone's
   * on the board (a link reset, a deletion).
   */
  async invalidate(boardId: string, actor?: Actor): Promise<void> {
    const identity = asIdentity(actor)
    try {
      if (identity) {
        await redis().del(roleKey(boardId, identity))
        return
      }
      const keys: string[] = []
      let cursor = '0'
      do {
        const [next, batch] = await redis().scan(
          cursor,
          'MATCH',
          `perm:${boardId}:*`,
          'COUNT',
          200,
        )
        cursor = next
        keys.push(...batch)
      } while (cursor !== '0')
      if (keys.length > 0) await redis().del(...keys)
    } catch (error) {
      // A missed invalidation is bounded by the 60 s TTL; failing the role
      // change itself over it would be worse.
      logger.warn({ err: error, boardId }, 'role cache invalidation failed')
    }
  }

  /**
   * The check on every write path — TRD §11.2's `assertCanEdit`.
   *
   * Every op message and every board-mutating endpoint goes through here (or
   * through `requireEdit`, which reaches the same answer uncached).
   */
  async assertCanEdit(boardId: string, actor: Actor): Promise<void> {
    const role = await this.getRole(boardId, actor)
    if (role === 'gone')
      throw new AuthError(ERROR_CODES.NOT_FOUND, 'Board not found', 404)
    if (role === 'none' || !canEdit(role)) {
      throw new AuthError(ERROR_CODES.FORBIDDEN, 'View-only access', 403)
    }
  }

  /**
   * Read access, or a 404.
   *
   * ┌──────────────────────────────────────────────────────────────────────┐
   * │  404, NOT 403, for a board you cannot see — R-SEC-018.               │
   * │                                                                      │
   * │  A 403 confirms the board exists. Probing ids and watching for 403   │
   * │  vs 404 would enumerate other people's boards.                       │
   * └──────────────────────────────────────────────────────────────────────┘
   */
  async requireRead(boardId: string, actor: Actor): Promise<Access> {
    const access = await this.resolve(boardId, actor)
    if (!access || access.role === 'none' || access.deletedAt) {
      throw new AuthError(ERROR_CODES.NOT_FOUND, 'Board not found', 404)
    }
    return access
  }

  async requireEdit(boardId: string, actor: Actor): Promise<Access> {
    const access = await this.requireRead(boardId, actor)
    if (!canEdit(access.role as Role)) {
      throw new AuthError(ERROR_CODES.FORBIDDEN, 'View-only access', 403)
    }
    return access
  }

  /**
   * Owner-only actions: rename, delete, sharing, members — FR-SHARE-001.
   * A member who is not the owner gets 403 (they can see the board exists);
   * a stranger gets 404. `AT-24`.
   */
  async requireOwner(boardId: string, actor: Actor): Promise<Access> {
    const access = await this.resolve(boardId, actor)
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
