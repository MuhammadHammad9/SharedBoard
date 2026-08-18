import { createHash, randomBytes } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL } from '@coboard/shared'
import { env } from './env.js'

/**
 * Token issuance and verification — TRD §11.1, decision D-11.
 *
 * | Token   | Storage                                        | Lifetime |
 * | ------- | ---------------------------------------------- | -------- |
 * | Access  | client memory only, never localStorage         | 15 min   |
 * | Refresh | httpOnly Secure SameSite=Lax cookie, rotated   | 30 days  |
 *
 * The access token is a signed JWT the server can verify without a database
 * round trip — that is the whole point of a 15-minute lifetime, since it
 * cannot be revoked early. The refresh token is the opposite: an opaque random
 * string with a row behind it, because it MUST be revocable (R-SEC-006).
 *
 * Making the refresh token a JWT too is the tempting mistake. A stateless
 * refresh token cannot be revoked, so reuse detection becomes impossible and
 * "log out everywhere" becomes a lie.
 */

export interface AccessClaims {
  /** User id. */
  sub: string
  /** Distinguishes the two secrets' audiences in case they are ever equal. */
  typ: 'access'
}

export function signAccessToken(userId: string): string {
  const claims: AccessClaims = { sub: userId, typ: 'access' }
  const options: jwt.SignOptions = { expiresIn: parseDuration(ACCESS_TOKEN_TTL) / 1000 }
  return jwt.sign(claims, env().JWT_ACCESS_SECRET, options)
}

/**
 * Verify an access token. Returns the user id, or null for anything wrong —
 * expired, tampered, signed with the refresh secret, or not a token at all.
 *
 * Deliberately returns null rather than throwing: every caller's response to
 * every failure mode is an identical 401, and distinguishing "expired" from
 * "forged" in the response would tell an attacker which of the two they
 * achieved.
 */
export function verifyAccessToken(token: string): string | null {
  try {
    const claims = jwt.verify(token, env().JWT_ACCESS_SECRET) as AccessClaims
    if (claims.typ !== 'access' || typeof claims.sub !== 'string') return null
    return claims.sub
  } catch {
    return null
  }
}

/* ── Refresh tokens ───────────────────────────────────────────────────────── */

/** 32 bytes = 256 bits of entropy, well past the 128-bit floor (R-SEC-009). */
const REFRESH_TOKEN_BYTES = 32

export function newRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url')
}

/**
 * Hash a bearer secret for storage — R-SEC-007.
 *
 * SHA-256, not bcrypt, and the difference matters. bcrypt is deliberately slow
 * because a *password* is low-entropy and must resist offline guessing. A
 * 256-bit random token is not guessable, so all the hash has to do is stop a
 * database dump from being a set of live sessions — and it has to be fast,
 * because it runs on the lookup path of every refresh.
 *
 * Using bcrypt here would also break the lookup entirely: bcrypt salts each
 * hash, so you cannot find a row by hashing the presented token. You would
 * have to scan every row and compare. SHA-256 is deterministic, so `tokenHash`
 * can carry a unique index.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Parse the '30d' style TTL into an absolute expiry. */
export function refreshExpiryFrom(now: Date = new Date()): Date {
  return new Date(now.getTime() + parseDuration(REFRESH_TOKEN_TTL))
}

/** Supports the `30d` / `15m` / `60s` forms used in the constants and .env. */
export function parseDuration(spec: string): number {
  const match = /^(\d+)([smhd])$/.exec(spec.trim())
  if (!match) throw new Error(`Unparseable duration: ${spec}`)
  const value = Number(match[1])
  const unit = match[2] as 's' | 'm' | 'h' | 'd'
  const ms = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]
  return value * ms
}
