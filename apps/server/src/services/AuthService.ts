import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import type { PrismaClient, User } from '@prisma/client'
import {
  BCRYPT_COST,
  ERROR_CODES,
  PASSWORD_RESET_TTL_MS,
  type PublicUser,
} from '@coboard/shared'
import {
  hashToken,
  newRefreshToken,
  refreshExpiryFrom,
  signAccessToken,
} from '../lib/jwt.js'
import { logger } from '../lib/logger.js'
import { prisma as defaultPrisma } from '../lib/prisma.js'

/**
 * Authentication — FR-AUTH-001/002/004/005/007, TRD §11.1.
 *
 * The service owns the rules; the routes own HTTP. Keeping them apart is what
 * lets the reuse-detection path be tested by calling a function twice rather
 * than by driving two HTTP requests and inspecting a Set-Cookie header.
 *
 * `prisma` is injected so a test can pass a client bound to a scratch schema.
 */

/** Thrown for every expected failure. The route maps `code` to a status. */
export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

export interface IssuedSession {
  user: PublicUser
  accessToken: string
  /** The plaintext refresh token. Only ever leaves in a Set-Cookie header. */
  refreshToken: string
  refreshExpiresAt: Date
}

/** The single redaction point — see PublicUserSchema in shared. */
export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    hasPassword: user.passwordHash !== null,
    createdAt: user.createdAt.toISOString(),
  }
}

export class AuthService {
  constructor(private readonly db: PrismaClient = defaultPrisma) {}

  /* ── Registration and login ─────────────────────────────────────────────── */

  async register(input: {
    email: string
    password: string
    displayName: string
    userAgent?: string
  }): Promise<IssuedSession> {
    const emailLower = input.email.toLowerCase()

    const existing = await this.db.user.findUnique({ where: { emailLower } })
    if (existing) {
      /*
       * Registration DOES reveal that an email is taken, and that is not a
       * violation of R-SEC-008.
       *
       * R-SEC-008 governs LOGIN and PASSWORD RESET, where a generic response
       * is what stops enumeration. A signup form cannot be generic — it has to
       * tell the user why it will not create their account, and FLOWS §3.1
       * branch 8b specifies exactly that, down to the "Log in instead" link.
       * Any signup form anywhere leaks this; hiding it here would break the
       * flow without buying secrecy.
       */
      throw new AuthError(ERROR_CODES.EMAIL_TAKEN, 'Email already registered', 409, {
        field: 'email',
      })
    }

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST)

    const user = await this.db.user.create({
      data: {
        email: input.email,
        emailLower,
        passwordHash,
        displayName: input.displayName,
      },
    })

    return this.issueSession(user, input.userAgent)
  }

  /**
   * Log in. Throws INVALID_CREDENTIALS for both a missing user and a wrong
   * password, with no timing shortcut between them — R-SEC-008.
   */
  async login(input: {
    email: string
    password: string
    userAgent?: string
  }): Promise<IssuedSession> {
    const user = await this.db.user.findUnique({
      where: { emailLower: input.email.toLowerCase() },
    })

    /*
     * The dummy hash is not busywork. Without it, a missing account returns in
     * ~1 ms and a wrong password in ~250 ms, and that 250× gap is a working
     * account-enumeration oracle — no error message needed, just a stopwatch.
     * Comparing against a real bcrypt hash makes both paths cost the same.
     */
    const hash = user?.passwordHash ?? DUMMY_HASH
    const ok = await bcrypt.compare(input.password, hash)

    if (!user || !user.passwordHash || !ok) {
      throw new AuthError(
        ERROR_CODES.INVALID_CREDENTIALS,
        'Invalid email or password',
        401,
      )
    }

    return this.issueSession(user, input.userAgent)
  }

  /* ── Sessions ───────────────────────────────────────────────────────────── */

  /** Mint an access token plus a brand-new refresh family. */
  async issueSession(user: User, userAgent?: string): Promise<IssuedSession> {
    const refreshToken = newRefreshToken()
    const expiresAt = refreshExpiryFrom()

    const row = await this.db.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        // Placeholder; the row's own id becomes the family root below.
        familyId: 'pending',
        expiresAt,
        userAgent: userAgent?.slice(0, 255),
      },
    })
    await this.db.refreshToken.update({
      where: { id: row.id },
      data: { familyId: row.id },
    })

    return {
      user: toPublicUser(user),
      accessToken: signAccessToken(user.id),
      refreshToken,
      refreshExpiresAt: expiresAt,
    }
  }

  /**
   * Rotate a refresh token — TRD §11.1, R-SEC-006.
   *
   * Every refresh mints a new token and revokes the one presented. Presenting
   * an ALREADY-revoked token means two parties hold the same secret, which
   * means it was stolen: the entire family is revoked and the real user is
   * forced to log in again.
   *
   * That is a deliberately harsh response to what is occasionally an innocent
   * cause — two tabs racing, or a retry after a dropped response. The
   * alternative is a grace window, and a grace window is exactly the hole an
   * attacker with a copied cookie needs. Losing a session is recoverable;
   * a silently shared session is not.
   */
  async rotate(presented: string, userAgent?: string): Promise<IssuedSession> {
    const tokenHash = hashToken(presented)
    const existing = await this.db.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    })

    if (!existing) {
      throw new AuthError(ERROR_CODES.INVALID_REFRESH, 'Unknown refresh token', 401)
    }

    if (existing.revokedAt) {
      logger.warn(
        { userId: existing.userId, familyId: existing.familyId },
        'refresh token reuse detected — revoking family',
      )
      await this.db.refreshToken.updateMany({
        where: { familyId: existing.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      throw new AuthError(ERROR_CODES.INVALID_REFRESH, 'Refresh token reused', 401)
    }

    if (existing.expiresAt.getTime() <= Date.now()) {
      throw new AuthError(ERROR_CODES.INVALID_REFRESH, 'Refresh token expired', 401)
    }

    const refreshToken = newRefreshToken()
    const expiresAt = refreshExpiryFrom()

    /*
     * One transaction: revoke the old row and insert the new one together.
     * Split across two statements, a crash between them either leaves the old
     * token live alongside the new (two valid sessions) or revokes the old
     * with no replacement (the user is logged out by a hiccup).
     */
    await this.db.$transaction([
      this.db.refreshToken.update({
        where: { id: existing.id },
        data: { revokedAt: new Date() },
      }),
      this.db.refreshToken.create({
        data: {
          userId: existing.userId,
          tokenHash: hashToken(refreshToken),
          // Same family — this is how reuse of ANY ancestor is caught.
          familyId: existing.familyId,
          expiresAt,
          userAgent: userAgent?.slice(0, 255),
        },
      }),
    ])

    return {
      user: toPublicUser(existing.user),
      accessToken: signAccessToken(existing.userId),
      refreshToken,
      refreshExpiresAt: expiresAt,
    }
  }

  /** Revoke one session — FR-AUTH-007. Idempotent: logging out twice is fine. */
  async logout(presented: string | undefined): Promise<void> {
    if (!presented) return
    await this.db.refreshToken.updateMany({
      where: { tokenHash: hashToken(presented), revokedAt: null },
      data: { revokedAt: new Date() },
    })
  }

  /** Revoke every session for a user — password reset and password change. */
  async revokeAllSessions(userId: string): Promise<number> {
    const { count } = await this.db.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    return count
  }

  async findById(userId: string): Promise<User | null> {
    return this.db.user.findUnique({ where: { id: userId } })
  }

  /* ── Password reset — FR-AUTH-004 ───────────────────────────────────────── */

  /**
   * Create a reset token. Returns null when no account matches.
   *
   * The route returns 200 either way (R-SEC-008); the null is what tells it
   * there is no email to send, not what it tells the caller.
   */
  async createPasswordReset(
    email: string,
  ): Promise<{ token: string; user: User } | null> {
    const user = await this.db.user.findUnique({
      where: { emailLower: email.toLowerCase() },
    })
    if (!user) return null

    const token = randomBytes(32).toString('base64url')
    await this.db.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      },
    })
    return { token, user }
  }

  /**
   * Check a reset token without consuming it — the S-05 on-mount validation.
   *
   * Three distinct failures, because FLOWS §5 renders a different banner for
   * each: expired, already used, and never valid. This is not the login path,
   * so there is no enumeration concern — the token itself is the secret, and
   * whoever holds it already knows it exists.
   */
  async validatePasswordReset(token: string): Promise<void> {
    const row = await this.db.passwordResetToken.findUnique({
      where: { tokenHash: hashToken(token) },
    })
    if (!row) throw new AuthError(ERROR_CODES.TOKEN_INVALID, 'Unknown reset token', 400)
    if (row.usedAt)
      throw new AuthError(ERROR_CODES.TOKEN_USED, 'Reset token already used', 400)
    if (row.expiresAt.getTime() <= Date.now())
      throw new AuthError(ERROR_CODES.TOKEN_EXPIRED, 'Reset token expired', 400)
  }

  /**
   * Consume a reset token and set the new password.
   *
   * Success invalidates every session for that user (FLOWS §5): if the reset
   * was triggered because someone else had the account, leaving their sessions
   * alive would make the whole exercise pointless.
   */
  async resetPassword(token: string, newPassword: string): Promise<User> {
    await this.validatePasswordReset(token)

    const tokenHash = hashToken(token)
    const row = await this.db.passwordResetToken.findUnique({ where: { tokenHash } })
    if (!row) throw new AuthError(ERROR_CODES.TOKEN_INVALID, 'Unknown reset token', 400)

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST)

    const [, user] = await this.db.$transaction([
      // Marking used INSIDE the transaction is what makes it single-use under
      // concurrency: two simultaneous submissions cannot both succeed.
      this.db.passwordResetToken.update({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() },
      }),
      this.db.user.update({ where: { id: row.userId }, data: { passwordHash } }),
      this.db.refreshToken.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ])

    return user
  }

  /* ── Profile — FR-SET-001 ───────────────────────────────────────────────── */

  async updateProfile(
    userId: string,
    patch: { displayName?: string; avatarUrl?: string | null },
  ): Promise<User> {
    return this.db.user.update({ where: { id: userId }, data: patch })
  }

  /**
   * Change or set a password.
   *
   * An OAuth-only account has no current password to verify, so `current` is
   * optional — but only when `passwordHash` is genuinely null. Otherwise it is
   * required, or anyone with a stolen access token could take the account over
   * without knowing the password.
   */
  async changePassword(
    userId: string,
    current: string | undefined,
    next: string,
  ): Promise<void> {
    const user = await this.db.user.findUnique({ where: { id: userId } })
    if (!user) throw new AuthError(ERROR_CODES.UNAUTHORIZED, 'No such user', 401)

    if (user.passwordHash) {
      if (!current) {
        throw new AuthError(
          ERROR_CODES.PASSWORD_REQUIRED,
          'Current password required',
          400,
          { field: 'currentPassword' },
        )
      }
      const ok = await bcrypt.compare(current, user.passwordHash)
      if (!ok) {
        throw new AuthError(
          ERROR_CODES.INVALID_CREDENTIALS,
          'Current password incorrect',
          400,
          { field: 'currentPassword' },
        )
      }
    }

    const passwordHash = await bcrypt.hash(next, BCRYPT_COST)
    await this.db.$transaction([
      this.db.user.update({ where: { id: userId }, data: { passwordHash } }),
      // Same reasoning as a reset: a password change should end sessions the
      // user may not control any more.
      this.db.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ])
  }

  /** Delete the account. Cascades take the tokens; Phase 8 adds boards. */
  async deleteAccount(userId: string, confirm: string): Promise<void> {
    const user = await this.db.user.findUnique({ where: { id: userId } })
    if (!user) throw new AuthError(ERROR_CODES.UNAUTHORIZED, 'No such user', 401)

    // Checked server-side as well as in the dialog — a confirmation enforced
    // only by the client is a confirmation an API caller skips.
    if (confirm.trim() !== user.displayName) {
      throw new AuthError(
        ERROR_CODES.CONFIRMATION_MISMATCH,
        'Confirmation text does not match',
        400,
      )
    }
    await this.db.user.delete({ where: { id: userId } })
  }

  /* ── Google OAuth — FR-AUTH-003 ─────────────────────────────────────────── */

  /**
   * Find or create a user for a verified Google profile.
   *
   * Linking is by email, per FR-AUTH-003, and only because Google asserts the
   * address is verified. Linking on an UNVERIFIED third-party email would be
   * an account-takeover primitive: register a Google account claiming
   * someone's address, sign in, inherit their boards. The `emailVerified`
   * check below is load-bearing, not defensive.
   */
  async upsertGoogleUser(profile: {
    googleId: string
    email: string
    emailVerified: boolean
    displayName: string
    avatarUrl?: string | null
  }): Promise<User> {
    const byGoogle = await this.db.user.findUnique({
      where: { googleId: profile.googleId },
    })
    if (byGoogle) return byGoogle

    const emailLower = profile.email.toLowerCase()
    const byEmail = await this.db.user.findUnique({ where: { emailLower } })

    if (byEmail) {
      if (!profile.emailVerified) {
        throw new AuthError(
          ERROR_CODES.OAUTH_FAILED,
          'Google account email is not verified; refusing to link',
          400,
        )
      }
      return this.db.user.update({
        where: { id: byEmail.id },
        data: {
          googleId: profile.googleId,
          // Only fill an avatar that is missing. Overwriting one the user
          // chose in CoBoard with their Google photo is not an improvement.
          avatarUrl: byEmail.avatarUrl ?? profile.avatarUrl ?? null,
          emailVerified: true,
        },
      })
    }

    return this.db.user.create({
      data: {
        email: profile.email,
        emailLower,
        googleId: profile.googleId,
        displayName: profile.displayName.slice(0, 40) || 'New user',
        avatarUrl: profile.avatarUrl ?? null,
        emailVerified: profile.emailVerified,
        // No passwordHash: this account cannot log in with a password until
        // the user sets one in Settings.
      },
    })
  }
}

/**
 * A real bcrypt hash of a value nobody can supply, used to keep the failed
 * login path the same cost as the successful one. Generated once at module
 * load rather than per request.
 */
const DUMMY_HASH = bcrypt.hashSync(randomBytes(32).toString('hex'), BCRYPT_COST)

export const authService = new AuthService()
