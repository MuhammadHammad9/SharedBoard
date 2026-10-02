import { randomBytes } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import type { Role } from '@coboard/shared'
import { prisma as defaultPrisma } from '../lib/prisma.js'
import { permissionService } from './PermissionService.js'

/**
 * Share links and the guests who come through them — FR-SHARE-002/003,
 * FR-AUTH-006, FLOWS §7 and §10.2.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  ONE LIVE LINK PER BOARD (decision D-3).                                 │
 * │                                                                          │
 * │  The share modal shows exactly one link, with one permission. Turning   │
 * │  it off or resetting it REVOKES the row rather than deleting it, so a    │
 * │  stale token answers "this link has been turned off" instead of the     │
 * │  less helpful "invalid" — and the guests who came in through it are     │
 * │  removed, because their access was the link.                            │
 * │                                                                          │
 * │  A partial unique index in the migration makes "one live link" a         │
 * │  database fact rather than a hope.                                       │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Every method that changes who can do what returns the identities it
 * affected, so the caller can push `role_changed` / `access_revoked` to their
 * live sockets (Phase 12c). Cached roles are invalidated here, before
 * returning, so the next op from any of them is judged on the new state.
 */

/** 32 bytes from the CSPRNG — 256 bits, base64url. R-SEC-009. */
export const newShareToken = (): string => randomBytes(32).toString('base64url')

/** Shape check before a token reaches the database. */
export const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/

export type LinkRole = Extract<Role, 'EDITOR' | 'VIEWER'>

export interface LiveLink {
  id: string
  token: string
  role: LinkRole
}

export type TokenLookup =
  | {
      status: 'ok'
      link: LiveLink
      boardId: string
      boardName: string
      ownerName: string
    }
  | { status: 'invalid' }
  | { status: 'revoked' }
  | { status: 'deleted' }

/** Who lost or changed access, for the live push. */
export interface AccessChange {
  revokedGuests: string[]
  changedGuests: string[]
}

export class ShareService {
  constructor(private readonly db: PrismaClient = defaultPrisma) {}

  async live(boardId: string): Promise<LiveLink | null> {
    const link = await this.db.shareLink.findFirst({
      where: { boardId, revokedAt: null },
      select: { id: true, token: true, role: true },
    })
    return link ? { ...link, role: link.role as LinkRole } : null
  }

  /**
   * Turn the link on with `role`, or change the live link's role.
   *
   * Changing it downgrades — or upgrades — the guests who came through it,
   * live (FLOWS §10.2 "Permission dropdown").
   */
  async enable(
    boardId: string,
    role: LinkRole,
    createdById: string,
  ): Promise<{ link: LiveLink; change: AccessChange }> {
    const existing = await this.live(boardId)
    if (!existing) {
      const link = await this.db.shareLink.create({
        data: { boardId, role, token: newShareToken(), createdById },
        select: { id: true, token: true, role: true },
      })
      return {
        link: { ...link, role: link.role as LinkRole },
        change: { revokedGuests: [], changedGuests: [] },
      }
    }
    if (existing.role === role) {
      return { link: existing, change: { revokedGuests: [], changedGuests: [] } }
    }

    const guests = await this.linkGuests(existing.id)
    await this.db.$transaction([
      this.db.shareLink.update({ where: { id: existing.id }, data: { role } }),
      this.db.boardMember.updateMany({
        where: { shareLinkId: existing.id, guestId: { not: null } },
        data: { role },
      }),
    ])
    await this.invalidateGuests(boardId, guests)
    return {
      link: { ...existing, role },
      change: { revokedGuests: [], changedGuests: guests },
    }
  }

  /** "Restricted" — the link stops working and its guests are removed. */
  async disable(boardId: string): Promise<AccessChange> {
    const existing = await this.live(boardId)
    if (!existing) return { revokedGuests: [], changedGuests: [] }
    const guests = await this.revoke(existing.id)
    await this.invalidateGuests(boardId, guests)
    return { revokedGuests: guests, changedGuests: [] }
  }

  /**
   * A new token with the same permission. Anyone using the old link loses
   * access (FLOWS §10.2 "Reset link").
   */
  async reset(
    boardId: string,
    createdById: string,
  ): Promise<{ link: LiveLink; change: AccessChange }> {
    const existing = await this.live(boardId)
    const role: LinkRole = existing?.role ?? 'EDITOR'
    const guests = existing ? await this.revoke(existing.id) : []
    const link = await this.db.shareLink.create({
      data: { boardId, role, token: newShareToken(), createdById },
      select: { id: true, token: true, role: true },
    })
    await this.invalidateGuests(boardId, guests)
    return {
      link: { ...link, role: link.role as LinkRole },
      change: { revokedGuests: guests, changedGuests: [] },
    }
  }

  /** What a token leads to — the public S-11 lookup. */
  async lookup(token: string): Promise<TokenLookup> {
    if (!SHARE_TOKEN.test(token)) return { status: 'invalid' }
    const link = await this.db.shareLink.findUnique({
      where: { token },
      select: {
        id: true,
        token: true,
        role: true,
        revokedAt: true,
        board: {
          select: {
            id: true,
            name: true,
            deletedAt: true,
            owner: { select: { displayName: true } },
          },
        },
      },
    })
    if (!link) return { status: 'invalid' }
    // A deleted board outranks a revoked link: "no longer exists" is the
    // truer and more final answer (FLOWS §7.3).
    if (link.board.deletedAt) return { status: 'deleted' }
    if (link.revokedAt) return { status: 'revoked' }
    return {
      status: 'ok',
      link: { id: link.id, token: link.token, role: link.role as LinkRole },
      boardId: link.board.id,
      boardName: link.board.name,
      ownerName: link.board.owner.displayName,
    }
  }

  /**
   * A guest joins through a live link — FLOWS §7.1 step 6.
   *
   * Idempotent on `(boardId, guestId)`: a returning guest (§7.2) keeps their
   * row and simply updates the name they gave. A guest whose row came from an
   * OLDER link is moved onto this one, at this link's role.
   */
  async joinAsGuest(
    link: LiveLink,
    boardId: string,
    guestId: string,
    name: string,
  ): Promise<Role> {
    const existing = await this.db.boardMember.findUnique({
      where: { boardId_guestId: { boardId, guestId } },
      select: { role: true, shareLinkId: true },
    })
    if (existing && existing.shareLinkId === link.id) {
      await this.db.boardMember.update({
        where: { boardId_guestId: { boardId, guestId } },
        data: { guestName: name, lastSeenAt: new Date() },
      })
      return existing.role
    }
    await this.db.boardMember.upsert({
      where: { boardId_guestId: { boardId, guestId } },
      create: {
        boardId,
        guestId,
        guestName: name,
        role: link.role,
        shareLinkId: link.id,
      },
      update: {
        guestName: name,
        role: link.role,
        shareLinkId: link.id,
        lastSeenAt: new Date(),
      },
    })
    await permissionService.invalidate(boardId, { kind: 'guest', guestId })
    return link.role
  }

  /**
   * A signed-in non-member opens a live link: they become a member at the
   * link's role (decision D-3), and stay one if the link is later turned off.
   */
  async joinAsUser(link: LiveLink, boardId: string, userId: string): Promise<Role> {
    const member = await this.db.boardMember.upsert({
      where: { boardId_userId: { boardId, userId } },
      create: { boardId, userId, role: link.role },
      update: {},
      select: { role: true },
    })
    await permissionService.invalidate(boardId, userId)
    return member.role
  }

  private async linkGuests(linkId: string): Promise<string[]> {
    const rows = await this.db.boardMember.findMany({
      where: { shareLinkId: linkId, guestId: { not: null } },
      select: { guestId: true },
    })
    return rows.map(r => r.guestId!).filter(Boolean)
  }

  /** Revoke a link and remove the guests who came through it. */
  private async revoke(linkId: string): Promise<string[]> {
    const guests = await this.linkGuests(linkId)
    await this.db.$transaction([
      this.db.shareLink.update({
        where: { id: linkId },
        data: { revokedAt: new Date() },
      }),
      this.db.boardMember.deleteMany({
        where: { shareLinkId: linkId, guestId: { not: null } },
      }),
    ])
    return guests
  }

  private async invalidateGuests(
    boardId: string,
    guests: readonly string[],
  ): Promise<void> {
    await Promise.all(
      guests.map(guestId =>
        permissionService.invalidate(boardId, { kind: 'guest', guestId }),
      ),
    )
  }
}

export const shareService = new ShareService()
