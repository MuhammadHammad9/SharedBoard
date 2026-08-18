import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import {
  ERROR_CODES,
  RATE_LIMIT_LOGIN_ATTEMPTS,
  PASSWORD_RESET_TTL_MS,
} from '@coboard/shared'
import { createApp } from '../http/app.js'
import { prisma } from '../lib/prisma.js'
import { closeRedis, redis, waitForRedis } from '../lib/redis.js'
import { hashToken, signAccessToken } from '../lib/jwt.js'
import { LoggingMailer, setMailer } from '../lib/mailer.js'
import { setExchanger } from '../lib/google.js'
import { REFRESH_COOKIE } from '../http/routes/auth.js'

/**
 * Auth integration — TRD §4.1, FR-AUTH-001/002/003/004/005/007, FR-SET-001.
 *
 * These run against a REAL Postgres and a REAL Redis, not mocks. Half of what
 * is being asserted here only exists in the database: the unique constraint on
 * `emailLower`, the cascade that removes tokens with a user, the transaction
 * that revokes a family atomically. A mocked Prisma would agree with whatever
 * the service did and prove none of it.
 *
 * Everything lives in one file, on purpose. The suite shares one database and
 * one Redis, and Vitest runs files in parallel — two files would interleave
 * writes to the same tables and produce failures that depend on scheduling.
 */

let app: Express
let mailer: LoggingMailer

const password = 'correct-horse-1'

/** Unique per call, so no test can be affected by another's rows. */
let counter = 0
const freshEmail = () => `user${++counter}.${Date.now()}@example.com`

async function registerUser(
  overrides: Partial<{ email: string; displayName: string }> = {},
) {
  const email = overrides.email ?? freshEmail()
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password, displayName: overrides.displayName ?? 'Priya Raman' })
  return { email, response }
}

/** Pull one cookie's value out of a Set-Cookie header. */
function cookieValue(response: request.Response, name: string): string | undefined {
  const raw = response.headers['set-cookie'] as unknown as string[] | undefined
  const match = raw?.find(c => c.startsWith(`${name}=`))
  if (!match) return undefined
  const value = match.slice(name.length + 1).split(';')[0]
  return value === '' ? undefined : value
}

const refreshCookie = (response: request.Response) =>
  cookieValue(response, REFRESH_COOKIE)

beforeAll(async () => {
  app = createApp()
  // Commands issued before the socket is up fail fast by design — see
  // waitForRedis. The suite must not degrade, so wait for it once here.
  await waitForRedis()
})

beforeEach(async () => {
  // Cascades take refresh and reset tokens with the user.
  await prisma.user.deleteMany({})
  // Rate-limit counters are keyed by email and IP; the IP is shared across the
  // whole suite, so a leftover count would leak between tests.
  const keys = await redis().keys('rl:*')
  if (keys.length > 0) await redis().del(...keys)

  mailer = new LoggingMailer()
  setMailer(mailer)
})

afterAll(async () => {
  await prisma.user.deleteMany({})
  await prisma.$disconnect()
  await closeRedis()
})

/* ── Registration — FR-AUTH-001 ───────────────────────────────────────────── */

describe('POST /api/auth/register', () => {
  it('creates the account, returns the user and an access token, sets the cookie', async () => {
    const { email, response } = await registerUser()

    expect(response.status).toBe(201)
    expect(response.body.user).toMatchObject({ email, displayName: 'Priya Raman' })
    expect(response.body.accessToken).toEqual(expect.any(String))
    expect(refreshCookie(response)).toBeTruthy()
  })

  it('never returns the password hash or any internal column', async () => {
    const { response } = await registerUser()
    const serialised = JSON.stringify(response.body)
    expect(serialised).not.toContain('passwordHash')
    expect(serialised).not.toContain('emailLower')
    expect(serialised).not.toContain('googleId')
    expect(serialised).not.toContain(password)
  })

  it('scopes the refresh cookie to /api/auth and marks it httpOnly', async () => {
    const { response } = await registerUser()
    const raw = (response.headers['set-cookie'] as unknown as string[]).find(c =>
      c.startsWith(REFRESH_COOKIE),
    )!
    // R-SEC-005: unreadable from JavaScript, so an XSS cannot take the 30-day
    // credential.
    expect(raw).toContain('HttpOnly')
    expect(raw).toContain('Path=/api/auth')
    expect(raw).toContain('SameSite=Lax')
  })

  it('rejects a duplicate email with 409 EMAIL_TAKEN', async () => {
    const { email } = await registerUser()
    const again = await request(app)
      .post('/api/auth/register')
      .send({ email, password, displayName: 'Someone Else' })

    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe(ERROR_CODES.EMAIL_TAKEN)
    expect(again.body.error.correlationId).toEqual(expect.any(String))
  })

  it('treats email as case-insensitive when detecting a duplicate', async () => {
    const { email } = await registerUser()
    const again = await request(app)
      .post('/api/auth/register')
      .send({ email: email.toUpperCase(), password, displayName: 'Shouty' })

    expect(again.status).toBe(409)
  })

  it('rejects a weak password with 422 and names the field', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ email: freshEmail(), password: 'short', displayName: 'Priya' })

    expect(response.status).toBe(422)
    expect(response.body.error.code).toBe(ERROR_CODES.VALIDATION_FAILED)
    expect(Object.keys(response.body.error.details)).toContain('password')
  })

  it('rejects a password with no digit — FR-AUTH-001', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ email: freshEmail(), password: 'allletters', displayName: 'Priya' })
    expect(response.status).toBe(422)
  })

  it('trims the display name and rejects one that is empty after trimming', async () => {
    const email = freshEmail()
    const ok = await request(app)
      .post('/api/auth/register')
      .send({ email, password, displayName: '  Priya Raman  ' })
    expect(ok.body.user.displayName).toBe('Priya Raman')

    const blank = await request(app)
      .post('/api/auth/register')
      .send({ email: freshEmail(), password, displayName: '   ' })
    expect(blank.status).toBe(422)
  })
})

/* ── Login — FR-AUTH-002 ──────────────────────────────────────────────────── */

describe('POST /api/auth/login', () => {
  it('returns a session for correct credentials', async () => {
    const { email } = await registerUser()
    const response = await request(app).post('/api/auth/login').send({ email, password })

    expect(response.status).toBe(200)
    expect(response.body.user.email).toBe(email)
    expect(refreshCookie(response)).toBeTruthy()
  })

  it('accepts a differently-cased email', async () => {
    const { email } = await registerUser()
    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: email.toUpperCase(), password })
    expect(response.status).toBe(200)
  })

  it('returns the SAME 401 for a wrong password and an unknown account — R-SEC-008', async () => {
    const { email } = await registerUser()

    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'wrong-password-1' })
    const noSuchUser = await request(app)
      .post('/api/auth/login')
      .send({ email: freshEmail(), password })

    expect(wrongPassword.status).toBe(401)
    expect(noSuchUser.status).toBe(401)
    // Identical code AND identical message. A different message for either
    // case is an account-enumeration oracle.
    expect(wrongPassword.body.error.code).toBe(ERROR_CODES.INVALID_CREDENTIALS)
    expect(noSuchUser.body.error.code).toBe(ERROR_CODES.INVALID_CREDENTIALS)
    expect(noSuchUser.body.error.message).toBe(wrongPassword.body.error.message)
  })

  it('rejects the 6th failed attempt for one email with 429 and a retryAfter', async () => {
    const { email } = await registerUser()

    for (let i = 0; i < RATE_LIMIT_LOGIN_ATTEMPTS; i++) {
      const attempt = await request(app)
        .post('/api/auth/login')
        .send({ email, password: 'wrong-password-1' })
      expect(attempt.status).toBe(401)
    }

    const blocked = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'wrong-password-1' })

    expect(blocked.status).toBe(429)
    expect(blocked.body.error.code).toBe(ERROR_CODES.RATE_LIMITED)
    // The countdown S-03 renders — FLOWS §4 branch 3c.
    expect(blocked.body.error.retryAfter).toBeGreaterThan(0)
  })

  it('is rate-limited even with the CORRECT password once the count is spent', async () => {
    const { email } = await registerUser()
    for (let i = 0; i < RATE_LIMIT_LOGIN_ATTEMPTS; i++) {
      await request(app)
        .post('/api/auth/login')
        .send({ email, password: 'wrong-password-1' })
    }
    // Otherwise the limiter is trivially bypassed by guessing right on try six.
    const blocked = await request(app).post('/api/auth/login').send({ email, password })
    expect(blocked.status).toBe(429)
  })

  it('clears the strike count after a successful login', async () => {
    const { email } = await registerUser()
    await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'wrong-password-1' })
    await request(app).post('/api/auth/login').send({ email, password })

    // Four more failures must not trip the limit: the counter was reset, so
    // this is attempt 4 of 5, not 6 of 5.
    for (let i = 0; i < 4; i++) {
      const attempt = await request(app)
        .post('/api/auth/login')
        .send({ email, password: 'wrong-password-1' })
      expect(attempt.status).toBe(401)
    }
  })

  it('refuses to log in to an OAuth-only account with a password', async () => {
    const email = freshEmail()
    await prisma.user.create({
      data: {
        email,
        emailLower: email.toLowerCase(),
        displayName: 'Google User',
        googleId: 'g-1',
      },
    })
    const response = await request(app).post('/api/auth/login').send({ email, password })
    expect(response.status).toBe(401)
  })
})

/* ── Refresh rotation — FR-AUTH-005, R-SEC-006 ────────────────────────────── */

describe('POST /api/auth/refresh', () => {
  it('issues a new access token and rotates the cookie', async () => {
    const { response: registered } = await registerUser()
    const first = refreshCookie(registered)!

    const refreshed = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${first}`)

    expect(refreshed.status).toBe(200)
    expect(refreshed.body.accessToken).toEqual(expect.any(String))

    const second = refreshCookie(refreshed)!
    expect(second).not.toBe(first)
  })

  it('revokes the presented token, so it cannot be used twice', async () => {
    const { response: registered } = await registerUser()
    const first = refreshCookie(registered)!

    await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${first}`)

    const row = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(first) },
    })
    expect(row?.revokedAt).toBeInstanceOf(Date)
  })

  it('401s with no cookie at all', async () => {
    const response = await request(app).post('/api/auth/refresh')
    expect(response.status).toBe(401)
    expect(response.body.error.code).toBe(ERROR_CODES.INVALID_REFRESH)
  })

  it('401s on an unknown token', async () => {
    const response = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=not-a-real-token`)
    expect(response.status).toBe(401)
  })

  it('REUSE DETECTION: replaying a revoked token revokes the whole family', async () => {
    const { response: registered } = await registerUser()
    const stolen = refreshCookie(registered)!

    // The legitimate client rotates twice; `stolen` is now revoked but the
    // attacker still holds a copy.
    const second = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${stolen}`)
    const live = refreshCookie(second)!

    const replay = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${stolen}`)
    expect(replay.status).toBe(401)

    // The crux: the token the REAL user holds is dead too. Both parties are
    // forced to re-authenticate, because we cannot tell which one was the
    // thief (R-SEC-006).
    const afterBreach = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${live}`)
    expect(afterBreach.status).toBe(401)

    const remaining = await prisma.refreshToken.count({ where: { revokedAt: null } })
    expect(remaining).toBe(0)
  })

  it('does not revoke a DIFFERENT session of the same user', async () => {
    const { email, response: registered } = await registerUser()
    const sessionA = refreshCookie(registered)!

    const loggedIn = await request(app).post('/api/auth/login').send({ email, password })
    const sessionB = refreshCookie(loggedIn)!

    // Breach session A.
    await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${sessionA}`)
    await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${sessionA}`)

    // The user's other device — a separate family — keeps working. Revoking
    // every session on any reuse would log people out of their phone because
    // a laptop tab raced.
    const other = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${sessionB}`)
    expect(other.status).toBe(200)
  })

  it('401s on an expired token', async () => {
    const { response: registered } = await registerUser()
    const token = refreshCookie(registered)!
    await prisma.refreshToken.update({
      where: { tokenHash: hashToken(token) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    const response = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${token}`)
    expect(response.status).toBe(401)
  })
})

/* ── Logout and /me — FR-AUTH-007 ─────────────────────────────────────────── */

describe('logout and /me', () => {
  it('returns the current user for a valid access token', async () => {
    const { email, response } = await registerUser()
    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${response.body.accessToken}`)

    expect(me.status).toBe(200)
    expect(me.body.user.email).toBe(email)
  })

  it('401s without a token, and with a malformed one', async () => {
    expect((await request(app).get('/api/auth/me')).status).toBe(401)
    expect(
      (await request(app).get('/api/auth/me').set('Authorization', 'Bearer nonsense'))
        .status,
    ).toBe(401)
  })

  it('401s when the token is signed with the WRONG secret', async () => {
    // A refresh secret must not verify an access token. If the two secrets
    // were ever set to the same value this is the test that catches it.
    const forged = [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'someone', typ: 'access' })).toString(
        'base64url',
      ),
      'not-a-valid-signature',
    ].join('.')

    const response = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${forged}`)
    expect(response.status).toBe(401)
  })

  it('logout revokes the session and clears the cookie', async () => {
    const { response: registered } = await registerUser()
    const token = refreshCookie(registered)!

    const out = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', `${REFRESH_COOKIE}=${token}`)
    expect(out.status).toBe(204)

    const after = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${token}`)
    expect(after.status).toBe(401)
  })

  it('logout is idempotent with no session', async () => {
    expect((await request(app).post('/api/auth/logout')).status).toBe(204)
  })
})

/* ── Password reset — FR-AUTH-004 ─────────────────────────────────────────── */

describe('password reset', () => {
  it('returns 200 for an address that does not exist — R-SEC-008', async () => {
    const response = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'nobody@example.com' })

    expect(response.status).toBe(200)
    // And crucially sends nothing, so timing and mail volume do not leak it.
    expect(mailer.sent).toHaveLength(0)
  })

  it('sends a reset link for an address that does exist, with the same 200', async () => {
    const { email } = await registerUser()
    const response = await request(app).post('/api/auth/forgot-password').send({ email })

    expect(response.status).toBe(200)
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0]!.to).toBe(email)
    expect(mailer.sent[0]!.expiresInMinutes).toBe(PASSWORD_RESET_TTL_MS / 60_000)
  })

  it('validates a fresh token without consuming it', async () => {
    const { email } = await registerUser()
    await request(app).post('/api/auth/forgot-password').send({ email })
    const token = new URL(mailer.sent[0]!.resetUrl).searchParams.get('token')!

    expect(
      (await request(app).get('/api/auth/reset/validate').query({ token })).status,
    ).toBe(200)
    // Still valid on a second check — S-05 validates on mount, and that must
    // not burn the token before the user has typed anything.
    expect(
      (await request(app).get('/api/auth/reset/validate').query({ token })).status,
    ).toBe(200)
  })

  it('reports TOKEN_INVALID, TOKEN_EXPIRED and TOKEN_USED distinctly', async () => {
    const { email } = await registerUser()

    const unknown = await request(app)
      .get('/api/auth/reset/validate')
      .query({ token: 'never-issued' })
    expect(unknown.body.error.code).toBe(ERROR_CODES.TOKEN_INVALID)

    await request(app).post('/api/auth/forgot-password').send({ email })
    const token = new URL(mailer.sent[0]!.resetUrl).searchParams.get('token')!
    await prisma.passwordResetToken.update({
      where: { tokenHash: hashToken(token) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    const expired = await request(app).get('/api/auth/reset/validate').query({ token })
    expect(expired.body.error.code).toBe(ERROR_CODES.TOKEN_EXPIRED)

    // FLOWS §5 renders a different banner for each of the three, which is why
    // they are not collapsed into one code.
  })

  it('resets the password, invalidates every session, and does NOT log the user in', async () => {
    const { email, response: registered } = await registerUser()
    const sessionBefore = refreshCookie(registered)!

    await request(app).post('/api/auth/forgot-password').send({ email })
    const token = new URL(mailer.sent[0]!.resetUrl).searchParams.get('token')!

    const newPassword = 'brand-new-pass-9'
    const reset = await request(app)
      .post('/api/auth/reset')
      .send({ token, password: newPassword })
    expect(reset.status).toBe(200)

    // No session in the response — FLOWS §5 forbids auto-login.
    expect(reset.body.accessToken).toBeUndefined()

    // Every prior session is dead.
    const stale = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${sessionBefore}`)
    expect(stale.status).toBe(401)

    expect(
      (await request(app).post('/api/auth/login').send({ email, password })).status,
    ).toBe(401)
    expect(
      (await request(app).post('/api/auth/login').send({ email, password: newPassword }))
        .status,
    ).toBe(200)
  })

  it('is single-use: the second submission of the same token fails', async () => {
    const { email } = await registerUser()
    await request(app).post('/api/auth/forgot-password').send({ email })
    const token = new URL(mailer.sent[0]!.resetUrl).searchParams.get('token')!

    await request(app)
      .post('/api/auth/reset')
      .send({ token, password: 'brand-new-pass-9' })
    const again = await request(app)
      .post('/api/auth/reset')
      .send({ token, password: 'another-pass-77' })

    expect(again.status).toBe(400)
    expect(again.body.error.code).toBe(ERROR_CODES.TOKEN_USED)
  })

  it('rejects a weak new password with 422', async () => {
    const { email } = await registerUser()
    await request(app).post('/api/auth/forgot-password').send({ email })
    const token = new URL(mailer.sent[0]!.resetUrl).searchParams.get('token')!

    const response = await request(app)
      .post('/api/auth/reset')
      .send({ token, password: 'weak' })
    expect(response.status).toBe(422)
  })
})

/* ── Google OAuth — FR-AUTH-003 ───────────────────────────────────────────── */

describe('Google OAuth account linking', () => {
  /**
   * The network call to Google is substituted; everything on our side of the
   * boundary is real, including the database. See lib/google.ts for why the
   * live round-trip is out of scope.
   */
  const withProfile = (profile: {
    googleId: string
    email: string
    emailVerified?: boolean
    displayName?: string
  }) => {
    setExchanger(async () => ({
      googleId: profile.googleId,
      email: profile.email,
      emailVerified: profile.emailVerified ?? true,
      displayName: profile.displayName ?? 'Google Person',
      avatarUrl: null,
    }))
  }

  /** Drive the callback with a matching state cookie, as Google would. */
  const callback = (code = 'auth-code') =>
    request(app)
      .get('/api/auth/google/callback')
      .query({ code, state: 'state-123' })
      .set('Cookie', 'coboard_oauth_state=state-123')

  it('creates a new account with no password hash', async () => {
    const email = freshEmail()
    withProfile({ googleId: 'google-new', email })

    const response = await callback()
    expect(response.status).toBe(302)
    expect(refreshCookie(response)).toBeTruthy()

    const user = await prisma.user.findUnique({
      where: { emailLower: email.toLowerCase() },
    })
    expect(user?.googleId).toBe('google-new')
    // An OAuth-only account cannot be logged into with a password until the
    // user sets one.
    expect(user?.passwordHash).toBeNull()
  })

  it('LINKS to an existing password account rather than duplicating it', async () => {
    const { email } = await registerUser()
    withProfile({ googleId: 'google-link', email })

    await callback()

    const users = await prisma.user.findMany({
      where: { emailLower: email.toLowerCase() },
    })
    expect(users).toHaveLength(1)
    expect(users[0]!.googleId).toBe('google-link')
    // The password still works — linking adds a way in, it does not replace one.
    expect(
      (await request(app).post('/api/auth/login').send({ email, password })).status,
    ).toBe(200)
  })

  it('REFUSES to link when Google says the email is unverified', async () => {
    const { email } = await registerUser()
    withProfile({ googleId: 'google-evil', email, emailVerified: false })

    const response = await callback()

    // Otherwise: register a Google account claiming someone else's address,
    // sign in, inherit their boards.
    expect(response.headers.location).toContain('error=oauth')
    const user = await prisma.user.findUnique({
      where: { emailLower: email.toLowerCase() },
    })
    expect(user?.googleId).toBeNull()
  })

  it('returns the same account on a second sign-in', async () => {
    const email = freshEmail()
    withProfile({ googleId: 'google-repeat', email })

    await callback()
    await callback()

    expect(await prisma.user.count({ where: { emailLower: email.toLowerCase() } })).toBe(
      1,
    )
  })

  it('rejects a callback whose state does not match the cookie — login CSRF', async () => {
    withProfile({ googleId: 'google-csrf', email: freshEmail() })

    const response = await request(app)
      .get('/api/auth/google/callback')
      .query({ code: 'auth-code', state: 'attacker-state' })
      .set('Cookie', 'coboard_oauth_state=real-state')

    expect(response.headers.location).toContain('error=oauth')
    expect(await prisma.user.count({ where: { googleId: 'google-csrf' } })).toBe(0)
  })

  it('sends the user back with oauth_denied when they cancel consent', async () => {
    const response = await request(app)
      .get('/api/auth/google/callback')
      .query({ error: 'access_denied' })
    expect(response.headers.location).toContain('error=oauth_denied')
  })
})

/* ── Profile — FR-SET-001 ─────────────────────────────────────────────────── */

describe('profile settings', () => {
  const authed = async () => {
    const { email, response } = await registerUser()
    return { email, token: response.body.accessToken as string }
  }

  it('updates the display name', async () => {
    const { token } = await authed()
    const response = await request(app)
      .patch('/api/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ displayName: 'Priya R.' })

    expect(response.status).toBe(200)
    expect(response.body.user.displayName).toBe('Priya R.')
  })

  it('requires authentication for every profile route', async () => {
    expect(
      (await request(app).patch('/api/auth/me').send({ displayName: 'x' })).status,
    ).toBe(401)
    expect(
      (await request(app).post('/api/auth/me/password').send({ newPassword: 'aaaaaaa1' }))
        .status,
    ).toBe(401)
    expect(
      (await request(app).post('/api/auth/me/delete').send({ confirm: 'x' })).status,
    ).toBe(401)
  })

  it('changes the password and revokes all sessions', async () => {
    const { email, response: registered } = await registerUser()
    const token = registered.body.accessToken as string
    const sessionBefore = refreshCookie(registered)!

    const changed = await request(app)
      .post('/api/auth/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: password, newPassword: 'a-new-password-2' })
    expect(changed.status).toBe(204)

    const stale = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=${sessionBefore}`)
    expect(stale.status).toBe(401)

    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .send({ email, password: 'a-new-password-2' })
      ).status,
    ).toBe(200)
  })

  it('refuses a password change without the current password', async () => {
    const { token } = await authed()
    const response = await request(app)
      .post('/api/auth/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ newPassword: 'a-new-password-2' })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe(ERROR_CODES.PASSWORD_REQUIRED)
  })

  it('refuses a password change with the WRONG current password', async () => {
    const { token } = await authed()
    const response = await request(app)
      .post('/api/auth/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'not-the-password-1', newPassword: 'a-new-password-2' })

    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe(ERROR_CODES.INVALID_CREDENTIALS)
  })

  it('lets an OAuth-only account SET a password with no current password', async () => {
    const email = freshEmail()
    const user = await prisma.user.create({
      data: {
        email,
        emailLower: email.toLowerCase(),
        displayName: 'Google Person',
        googleId: `g-${email}`,
      },
    })

    const response = await request(app)
      .post('/api/auth/me/password')
      .set('Authorization', `Bearer ${signAccessToken(user.id)}`)
      .send({ newPassword: 'first-password-1' })

    // No currentPassword required, because there is no current password —
    // this is a first password, not a change.
    expect(response.status).toBe(204)
    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .send({ email, password: 'first-password-1' })
      ).status,
    ).toBe(200)
  })

  it('deletes the account only when the confirmation matches the display name', async () => {
    const { email, response: registered } = await registerUser()
    const token = registered.body.accessToken as string

    const wrong = await request(app)
      .post('/api/auth/me/delete')
      .set('Authorization', `Bearer ${token}`)
      .send({ confirm: 'not my name' })
    expect(wrong.status).toBe(400)
    expect(wrong.body.error.code).toBe(ERROR_CODES.CONFIRMATION_MISMATCH)

    const right = await request(app)
      .post('/api/auth/me/delete')
      .set('Authorization', `Bearer ${token}`)
      .send({ confirm: 'Priya Raman' })
    expect(right.status).toBe(204)

    expect(
      await prisma.user.findUnique({ where: { emailLower: email.toLowerCase() } }),
    ).toBeNull()
    // The cascade took the tokens with it.
    expect(await prisma.refreshToken.count()).toBe(0)
  })
})

/* ── The error envelope — TRD §4 ──────────────────────────────────────────── */

describe('error envelope', () => {
  it('carries a code, a message and a correlationId on every failure', async () => {
    const response = await request(app).get('/api/auth/me')
    expect(response.body.error).toMatchObject({
      code: expect.any(String),
      message: expect.any(String),
      correlationId: expect.stringMatching(/^[0-9a-f]{8}$/),
    })
  })

  it('404s an unknown route inside the same envelope', async () => {
    const response = await request(app).get('/api/auth/nope')
    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe(ERROR_CODES.NOT_FOUND)
  })

  it('never leaks a stack trace', async () => {
    const response = await request(app).get('/api/auth/me')
    expect(JSON.stringify(response.body)).not.toContain('at ')
  })
})
