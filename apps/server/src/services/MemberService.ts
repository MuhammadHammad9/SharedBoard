import type { PrismaClient } from '@prisma/client'
import { ERROR_CODES, type Role } from '@coboard/shared'
import { prisma as defaultPrisma } from '../lib/prisma.js'
import { getMailer } from '../lib/mailer.js'
import type { Identity } from '../lib/identity.js'
import { AuthError } from './AuthService.js'
import { permissionService } from './PermissionService.js'

/**
 * People with access to a board — FR-SHARE-001/004, FLOWS §10.2–10.3,
 * TRD §4.3.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  THE OWNER ROW IS NOT EDITABLE HERE.                                     │
 * │                                                                          │
 * │  Board creation writes the owner as a member with role OWNER. Exactly   │
 * │  one owner per board (FR-SHARE-001), and ownership transfer is P2 — so   │
 * │  no endpoint in this file may demote, remove or "leave" that row, and   │
 * │  none may grant OWNER to anyone else.                                    │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Each mutation invalidates the affected cached role BEFORE returning, so the
 * very next op from that person is judged on the new state; the caller then
 * pushes the live message (ws/live.ts).
 */

export type MemberRole = Extract<Role, 'EDITOR' | 'VIEWER'>

export interface MemberView {
  /** The membership row's id — what PATCH and DELETE take. */
  id: string
  kind: 'user' | 'guest'
  name: string
  /** Users only. A guest has no email, and its guest id is never exposed (D-1). */
  email: string | null
  role: Role
  isOwner: boolean
}

export interface InviteView {
  email: string
  role: MemberRole
}

/** FLOWS §10.3: guests go once the board has been idle this long. */
export const GUEST_IDLE_MS = 24 * 60 * 60 * 1000

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export class MemberService {
  constructor(private readonly db: PrismaClient = defaultPrisma) {}

  async list(boardId: string): Promise<{ members: MemberView[]; invites: InviteView[] }> {
    const [rows, invites] = await Promise.all([
      this.db.boardMember.findMany({
        where: { boardId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          role: true,
          guestName: true,
          user: { select: { displayName: true, email: true } },
        },
      }),
      this.db.boardInvite.findMany({
        where: { boardId, claimedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { email: true, role: true },
      }),
    ])

    const members: MemberView[] = rows.map(row => ({
      id: row.id,
      kind: row.user ? 'user' : 'guest',
      name: row.user?.displayName ?? row.guestName ?? 'Guest',
      email: row.user?.email ?? null,
      role: row.role,
      isOwner: row.role === 'OWNER',
    }))
    // The owner first, as FLOWS §10.1 draws it.
    members.sort((a, b) => Number(b.isOwner) - Number(a.isOwner))
    return {
      members,
      invites: invites.map(i => ({ email: i.email, role: i.role as MemberRole })),
    }
  }

  /**
   * Invite by email — FR-SHARE-004.
   *
   * A registered address becomes a member at once and sees the board on
   * their dashboard. An unregistered one gets a `BoardInvite` and an email;
   * the invite is claimed when that address signs up. An existing member is
   * left exactly as they are — an invite never demotes anyone, least of all
   * the owner.
   */
  async invite(
    boardId: string,
    emails: readonly string[],
    role: MemberRole,
    inviterId: string,
    origin: string,
  ): Promise<{ added: string[]; invited: string[] }> {
    const normalised = [...new Set(emails.map(e => e.trim().toLowerCase()))]
    const bad = normalised.filter(e => !EMAIL.test(e))
    if (bad.length > 0) {
      throw new AuthError(ERROR_CODES.VALIDATION_FAILED, 'Invalid email address', 422, {
        invalid: bad,
      })
    }

    const [board, inviter] = await Promise.all([
      this.db.board.findUniqueOrThrow({ where: { id: boardId }, select: { name: true } }),
      this.db.user.findUniqueOrThrow({
        where: { id: inviterId },
        select: { displayName: true },
      }),
    ])

    const added: string[] = []
    const invited: string[] = []
    for (const email of normalised) {
      const user = await this.db.user.findUnique({
        where: { emailLower: email },
        select: { id: true },
      })
      if (user) {
        await this.db.boardMember.upsert({
          where: { boardId_userId: { boardId, userId: user.id } },
          create: { boardId, userId: user.id, role, addedById: inviterId },
          update: {},
        })
        await permissionService.invalidate(boardId, user.id)
        added.push(email)
        continue
      }
      await this.db.boardInvite.upsert({
        where: { boardId_email: { boardId, email } },
        create: { boardId, email, role, invitedById: inviterId },
        update: { role, claimedAt: null },
      })
      await getMailer().sendBoardInvite({
        to: email,
        inviterName: inviter.displayName,
        boardName: board.name,
        role,
        url: `${origin}/signup?next=${encodeURIComponent(`/board/${boardId}`)}`,
      })
      invited.push(email)
    }
    return { added, invited }
  }

  /**
   * Change a member's role. Returns who it was, for the live push.
   * The owner row cannot be changed and OWNER cannot be granted.
   */
  async setRole(boardId: string, memberId: string, role: MemberRole): Promise<Identity> {
    const member = await this.findEditable(boardId, memberId)
    await this.db.boardMember.update({ where: { id: memberId }, data: { role } })
    const identity = toIdentity(member)
    await permissionService.invalidate(boardId, identity)
    return identity
  }

  /** Remove a member. Returns who it was, for the live push. */
  async remove(boardId: string, memberId: string): Promise<Identity> {
    const member = await this.findEditable(boardId, memberId)
    await this.db.boardMember.delete({ where: { id: memberId } })
    const identity = toIdentity(member)
    await permissionService.invalidate(boardId, identity)
    return identity
  }

  /** "Leave board". The owner cannot leave their own board. */
  async leave(boardId: string, identity: Identity): Promise<void> {
    const where =
      identity.kind === 'user'
        ? { boardId, userId: identity.userId }
        : { boardId, guestId: identity.guestId }
    const member = await this.db.boardMember.findFirst({
      where,
      select: { id: true, role: true },
    })
    if (!member) throw new AuthError(ERROR_CODES.NOT_FOUND, 'Board not found', 404)
    if (member.role === 'OWNER') {
      throw new AuthError(ERROR_CODES.FORBIDDEN, 'The owner cannot leave the board', 403)
    }
    await this.db.boardMember.delete({ where: { id: member.id } })
    await permissionService.invalidate(boardId, identity)
  }

  /** Whether any live invite is waiting for this address — D-22. */
  async hasPendingInvites(emailLower: string): Promise<boolean> {
    const count = await this.db.boardInvite.count({
      where: { email: emailLower, claimedAt: null, board: { deletedAt: null } },
    })
    return count > 0
  }

  /**
   * Turn an account's pending invites into memberships — FR-SHARE-004
   * "on signup they are auto-added".
   *
   * D-22: ONLY for a PROVEN address. An invite is addressed to whoever reads
   * that mailbox, and typing an address into a signup form proves nothing —
   * claiming at registration let anyone who guessed an invitee's address walk
   * into the board. Callers claim after a verified Google sign-in or an opened
   * verification link; this re-checks it anyway, so a future caller that
   * forgets cannot reopen the hole.
   */
  async claimInvites(userId: string, emailLower: string): Promise<number> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { emailLower: true, emailVerifiedAt: true },
    })
    if (!user?.emailVerifiedAt || user.emailLower !== emailLower) return 0

    const invites = await this.db.boardInvite.findMany({
      where: { email: emailLower, claimedAt: null, board: { deletedAt: null } },
      select: { id: true, boardId: true, role: true, invitedById: true },
    })
    for (const invite of invites) {
      await this.db.$transaction([
        this.db.boardMember.upsert({
          where: { boardId_userId: { boardId: invite.boardId, userId } },
          create: {
            boardId: invite.boardId,
            userId,
            role: invite.role,
            addedById: invite.invitedById,
          },
          update: {},
        }),
        this.db.boardInvite.update({
          where: { id: invite.id },
          data: { claimedAt: new Date() },
        }),
      ])
    }
    return invites.length
  }

  /**
   * Guest → account — FLOWS §7.4. The person who was guest `guestId` on this
   * board has just signed up (or in) as `userId`; their guest membership
   * becomes their account's.
   *
   * D-23: the guest's ROLE carries over — FLOWS says "added as an Editor",
   * which assumed the guest came in on an edit link. A guest on a VIEWER link
   * who signed up used to come out an editor: sign-up as privilege
   * escalation. The result is the higher of the guest's role and any
   * membership the account already had; it never raises a viewer, and never
   * lowers anyone.
   *
   * Proof of being that guest is the guest id itself — the bearer secret only
   * that browser holds (D-1).
   */
  async claimGuest(boardId: string, guestId: string, userId: string): Promise<Role> {
    const guest = await this.db.boardMember.findUnique({
      where: { boardId_guestId: { boardId, guestId } },
      select: { id: true, role: true },
    })
    if (!guest) throw new AuthError(ERROR_CODES.NOT_FOUND, 'Guest not found', 404)

    const existing = await this.db.boardMember.findUnique({
      where: { boardId_userId: { boardId, userId } },
      select: { role: true },
    })
    const rank: Record<Role, number> = { VIEWER: 0, EDITOR: 1, OWNER: 2 }
    const role: Role =
      existing && rank[existing.role] > rank[guest.role] ? existing.role : guest.role
    await this.db.$transaction([
      this.db.boardMember.delete({ where: { id: guest.id } }),
      this.db.boardMember.upsert({
        where: { boardId_userId: { boardId, userId } },
        create: { boardId, userId, role },
        update: { role },
      }),
    ])
    await Promise.all([
      permissionService.invalidate(boardId, { kind: 'guest', guestId }),
      permissionService.invalidate(boardId, userId),
    ])
    return role
  }

  /**
   * FLOWS §10.3 / PRD Q-1 (interim, decision D-2): a guest who has left stays
   * listed "for the session", and is dropped once the board has been idle for
   * 24 hours.
   *
   * Idle means all three: no op in 24 h (`lastActivityAt`), no guest joined
   * or came back in 24 h (`lastSeenAt` — a returning guest re-joins on every
   * visit), and nobody connected on any instance right now (`isLive`, the
   * Redis presence hash). Returns how many guest rows were removed.
   */
  async sweepIdleGuests(
    isLive: (boardId: string) => Promise<boolean>,
    now = Date.now(),
  ): Promise<number> {
    const cutoff = new Date(now - GUEST_IDLE_MS)
    const candidates = await this.db.board.findMany({
      where: {
        lastActivityAt: { lt: cutoff },
        members: { some: { guestId: { not: null } } },
        NOT: {
          members: { some: { guestId: { not: null }, lastSeenAt: { gte: cutoff } } },
        },
      },
      select: { id: true },
    })

    let removed = 0
    for (const { id: boardId } of candidates) {
      if (await isLive(boardId)) continue
      const guests = await this.db.boardMember.findMany({
        where: { boardId, guestId: { not: null } },
        select: { guestId: true },
      })
      const { count } = await this.db.boardMember.deleteMany({
        where: { boardId, guestId: { not: null }, lastSeenAt: { lt: cutoff } },
      })
      removed += count
      await Promise.all(
        guests.map(g =>
          permissionService.invalidate(boardId, { kind: 'guest', guestId: g.guestId! }),
        ),
      )
    }
    return removed
  }

  private async findEditable(boardId: string, memberId: string) {
    const member = await this.db.boardMember.findFirst({
      where: { id: memberId, boardId },
      select: { id: true, role: true, userId: true, guestId: true },
    })
    if (!member) throw new AuthError(ERROR_CODES.NOT_FOUND, 'Member not found', 404)
    if (member.role === 'OWNER') {
      throw new AuthError(ERROR_CODES.FORBIDDEN, 'The owner cannot be changed here', 403)
    }
    return member
  }
}

function toIdentity(member: { userId: string | null; guestId: string | null }): Identity {
  return member.userId
    ? { kind: 'user', userId: member.userId }
    : { kind: 'guest', guestId: member.guestId! }
}

export const memberService = new MemberService()
