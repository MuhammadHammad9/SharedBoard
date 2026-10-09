import type { RequestHandler } from 'express'
import {
  ERROR_CODES,
  RATE_LIMIT_LOGIN_ATTEMPTS,
  RATE_LIMIT_LOGIN_PER_IP,
  RATE_LIMIT_LOGIN_WINDOW_MS,
} from '@coboard/shared'
import { clearCounter, hitCounter, releaseCounter } from '../../lib/redis.js'
import { HttpError } from './errorHandler.js'

/**
 * Rate limiting — FR-AUTH-002, R-SEC-013.
 *
 * Two independent limits, because they stop different attacks:
 *
 *   per email  5 / 15 min  — someone guessing ONE account's password
 *   per IP    20 / 15 min  — someone spraying one password across many accounts
 *
 * An email-only limit misses the spray entirely; an IP-only limit misses an
 * attacker with a proxy pool. Neither subsumes the other.
 *
 * Counted on FAILURE only (see `clearLoginAttempts`).
 * Counting successful logins too would lock out a shared office IP for doing
 * nothing wrong.
 */

const WINDOW_SECONDS = Math.ceil(RATE_LIMIT_LOGIN_WINDOW_MS / 1000)

export const emailKey = (email: string) => `rl:login:email:${email.toLowerCase()}`
export const ipKey = (ip: string) => `rl:login:ip:${ip}`

/** Express's req.ip honours trust proxy; fall back for direct connections. */
export const clientIp = (req: { ip?: string; socket?: { remoteAddress?: string } }) =>
  req.ip ?? req.socket?.remoteAddress ?? 'unknown'

/**
 * Check both counters BEFORE doing any work.
 *
 * Checked ahead of the bcrypt compare on purpose: verifying a password at cost
 * 12 is ~250 ms of CPU, so a limiter that runs afterwards still lets an
 * attacker consume the server's CPU at will. Rejecting first makes a
 * rate-limited attempt nearly free to refuse.
 */
export async function assertLoginAllowed(email: string, ip: string): Promise<void> {
  const [byEmail, byIp] = await Promise.all([
    hitCounter(emailKey(email), RATE_LIMIT_LOGIN_WINDOW_MS),
    hitCounter(ipKey(ip), RATE_LIMIT_LOGIN_WINDOW_MS),
  ])

  const over =
    byEmail.count > RATE_LIMIT_LOGIN_ATTEMPTS
      ? byEmail
      : byIp.count > RATE_LIMIT_LOGIN_PER_IP
        ? byIp
        : null

  if (over) {
    // retryAfter is what lets S-03 render a live countdown rather than a vague
    // "try again later" — FLOWS §4 branch 3c.
    throw new HttpError(
      ERROR_CODES.RATE_LIMITED,
      'Too many attempts',
      429,
      undefined,
      over.resetSeconds || WINDOW_SECONDS,
    )
  }
}

/**
 * A successful login clears the EMAIL's strikes and takes back the one IP hit
 * this attempt cost. It never clears the IP counter.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  Clearing the IP counter on success was a password-spray bypass          │
 * │  (finding 9): nineteen guesses against other people's accounts, one      │
 * │  correct login to the attacker's own, counter back to zero, repeat.      │
 * │                                                                          │
 * │  Not clearing it at all is the older lockout bug instead: both counters  │
 * │  are incremented BEFORE the password is checked, so an office behind one │
 * │  NAT would hit 20 on successful logins alone (D-14).                     │
 * │                                                                          │
 * │  Releasing exactly the hit this attempt took satisfies both: the IP      │
 * │  counter ends up counting failures and nothing else. A success leaves it │
 * │  where it was before the attempt — never lower.                          │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
export async function clearLoginAttempts(email: string, ip?: string): Promise<void> {
  await Promise.all([
    clearCounter(emailKey(email)),
    ip ? releaseCounter(ipKey(ip)) : Promise.resolve(),
  ])
}

/**
 * A generic fixed-window limiter for the endpoints that need one but have no
 * per-account identity — registration and forgot-password, which are both
 * abusable by an unauthenticated caller.
 */
export const limitByIp = (
  bucket: string,
  max: number,
  windowMs: number = RATE_LIMIT_LOGIN_WINDOW_MS,
): RequestHandler => {
  return (req, _res, next) => {
    void (async () => {
      const { count, resetSeconds } = await hitCounter(
        `rl:${bucket}:${clientIp(req)}`,
        windowMs,
      )
      if (count > max) {
        next(
          new HttpError(
            ERROR_CODES.RATE_LIMITED,
            'Too many requests',
            429,
            undefined,
            resetSeconds,
          ),
        )
        return
      }
      next()
    })()
  }
}
