import { randomBytes } from 'node:crypto'
import { Router, type CookieOptions, type Request, type Response } from 'express'
import { z } from 'zod'
import {
  ChangePasswordSchema,
  DeleteAccountSchema,
  ERROR_CODES,
  ForgotPasswordSchema,
  LoginSchema,
  PASSWORD_RESET_TTL_MS,
  RegisterSchema,
  ResetPasswordSchema,
  UpdateProfileSchema,
} from '@coboard/shared'
import { AuthError, authService, toPublicUser } from '../../services/AuthService.js'
import { buildAuthUrl, getExchanger, redirectUri } from '../../lib/google.js'
import { env } from '../../lib/env.js'
import { getMailer } from '../../lib/mailer.js'
import { assertAuthenticated, requireAuth } from '../middleware/auth.js'
import { ah, HttpError } from '../middleware/errorHandler.js'
import { validateBody } from '../middleware/validate.js'
import {
  assertLoginAllowed,
  clearLoginAttempts,
  clientIp,
  limitByIp,
} from '../middleware/rateLimit.js'

/**
 * Auth endpoints — TRD §4.1, FLOWS §3, §4, §5.
 *
 * Handlers are thin on purpose: parse, call the service, shape the response.
 * Every rule that matters lives in `AuthService`, where it can be tested
 * without an HTTP round trip and reused by the WebSocket gateway in Phase 9.
 *
 * Every async handler is wrapped in `ah`. Express 4 does not await handlers,
 * so an unwrapped rejection becomes an unhandled promise and the request
 * hangs with no response and no log line.
 */

export const REFRESH_COOKIE = 'coboard_rt'
const OAUTH_STATE_COOKIE = 'coboard_oauth_state'

/**
 * Refresh-cookie options — TRD §11.1, R-SEC-005.
 *
 * `httpOnly`  JavaScript cannot read it, so an XSS cannot exfiltrate the
 *             30-day credential. This is the whole reason the access token
 *             lives in memory and the refresh token lives here.
 * `sameSite`  'lax', not 'strict' — strict would break the OAuth return,
 *             which is a cross-site top-level navigation back from Google.
 * `secure`    Off in development only; localhost is plain HTTP and a Secure
 *             cookie would simply never be set.
 * `path`      Scoped to the auth routes, so it is not attached to every API
 *             call. A cookie sent where it is not needed is one more place it
 *             can leak from.
 */
export function refreshCookieOptions(expiresAt: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: env().NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/auth',
    expires: expiresAt,
  }
}

function clearOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env().NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/auth',
  }
}

/** Set the rotated refresh cookie, then send the JSON body. */
function respondWithSession(
  res: Response,
  session: { refreshToken: string; refreshExpiresAt: Date },
  status: number,
  body: Record<string, unknown>,
): void {
  res
    .cookie(
      REFRESH_COOKIE,
      session.refreshToken,
      refreshCookieOptions(session.refreshExpiresAt),
    )
    .status(status)
    .json(body)
}

const readCookie = (req: Request, name: string): string | undefined =>
  (req.cookies as Record<string, string> | undefined)?.[name]

export function createAuthRouter(): Router {
  const router = Router()

  /* ── POST /auth/register ──────────────────────────────────────────────── */

  router.post(
    '/register',
    limitByIp('register', 10),
    validateBody(RegisterSchema),
    ah(async (req, res) => {
      const session = await authService.register({
        ...(req.body as { email: string; password: string; displayName: string }),
        userAgent: req.headers['user-agent'],
      })
      respondWithSession(res, session, 201, {
        user: session.user,
        accessToken: session.accessToken,
      })
    }),
  )

  /* ── POST /auth/login ─────────────────────────────────────────────────── */

  router.post(
    '/login',
    validateBody(LoginSchema),
    ah(async (req, res) => {
      const { email, password } = req.body as { email: string; password: string }

      // Checked BEFORE bcrypt, not after — see the note in rateLimit.ts.
      await assertLoginAllowed(email, clientIp(req))

      const session = await authService.login({
        email,
        password,
        userAgent: req.headers['user-agent'],
      })
      await clearLoginAttempts(email)

      respondWithSession(res, session, 200, {
        user: session.user,
        accessToken: session.accessToken,
      })
    }),
  )

  /* ── POST /auth/refresh ───────────────────────────────────────────────── */

  router.post(
    '/refresh',
    ah(async (req, res) => {
      const presented = readCookie(req, REFRESH_COOKIE)
      if (!presented) {
        throw new HttpError(ERROR_CODES.INVALID_REFRESH, 'No refresh cookie', 401)
      }

      let session
      try {
        session = await authService.rotate(presented, req.headers['user-agent'])
      } catch (err) {
        // Clear the dead cookie on the way out. Leaving it means the browser
        // keeps presenting a token that can never work, and every cold load
        // pays a pointless round trip before showing the login screen.
        res.clearCookie(REFRESH_COOKIE, clearOptions())
        throw err
      }

      respondWithSession(res, session, 200, {
        accessToken: session.accessToken,
        user: session.user,
      })
    }),
  )

  /* ── POST /auth/logout ────────────────────────────────────────────────── */

  router.post(
    '/logout',
    ah(async (req, res) => {
      await authService.logout(readCookie(req, REFRESH_COOKIE))
      // 204 whether or not there was a session. Logging out is not a question
      // about whether you were logged in.
      res.clearCookie(REFRESH_COOKIE, clearOptions()).status(204).end()
    }),
  )

  /* ── GET /auth/me ─────────────────────────────────────────────────────── */

  router.get(
    '/me',
    requireAuth,
    ah(async (req, res) => {
      const user = await authService.findById(assertAuthenticated(req))
      if (!user) {
        throw new HttpError(ERROR_CODES.UNAUTHORIZED, 'User no longer exists', 401)
      }
      res.json({ user: toPublicUser(user) })
    }),
  )

  /* ── Password reset — FR-AUTH-004, FLOWS §5 ───────────────────────────── */

  router.post(
    '/forgot-password',
    limitByIp('forgot', 10),
    validateBody(ForgotPasswordSchema),
    ah(async (req, res) => {
      const { email } = req.body as { email: string }
      const created = await authService.createPasswordReset(email)

      if (created) {
        const url = new URL('/reset-password', env().CLIENT_ORIGIN)
        url.searchParams.set('token', created.token)
        await getMailer().sendPasswordReset({
          to: created.user.email,
          displayName: created.user.displayName,
          resetUrl: url.toString(),
          expiresInMinutes: PASSWORD_RESET_TTL_MS / 60_000,
        })
      }

      /*
       * 200 either way — R-SEC-008. The response must be identical whether or
       * not the account exists, or this endpoint is a free account-enumeration
       * oracle for anyone with a word list.
       */
      res.status(200).json({ ok: true })
    }),
  )

  router.get(
    '/reset/validate',
    ah(async (req, res) => {
      const token = z.string().min(1).max(512).safeParse(req.query.token)
      if (!token.success) {
        throw new AuthError(ERROR_CODES.TOKEN_INVALID, 'Missing token', 400)
      }
      await authService.validatePasswordReset(token.data)
      res.json({ valid: true })
    }),
  )

  router.post(
    '/reset',
    validateBody(ResetPasswordSchema),
    ah(async (req, res) => {
      const { token, password } = req.body as { token: string; password: string }
      await authService.resetPassword(token, password)

      /*
       * No session is issued. FLOWS §5: "Do not auto-log-in after a reset."
       * An explicit login is what confirms the person who set the password is
       * the person who knows it — otherwise a leaked reset link hands over a
       * live session in a single click.
       */
      res.clearCookie(REFRESH_COOKIE, clearOptions()).status(200).json({ ok: true })
    }),
  )

  /* ── Google OAuth — FR-AUTH-003 ───────────────────────────────────────── */

  router.get('/google', (req: Request, res: Response) => {
    const state = randomBytes(16).toString('base64url')
    res.cookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: env().NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000,
      path: '/api/auth',
    })
    res.redirect(buildAuthUrl(state))
  })

  router.get(
    '/google/callback',
    ah(async (req, res) => {
      const fail = (reason: string) => {
        const url = new URL('/login', env().CLIENT_ORIGIN)
        url.searchParams.set('error', reason)
        res.redirect(url.toString())
      }

      // The user pressed Cancel on Google's consent screen — FLOWS §3.3.
      if (typeof req.query.error === 'string') return fail('oauth_denied')

      const { code, state } = req.query
      const expected = readCookie(req, OAUTH_STATE_COOKIE)

      if (typeof code !== 'string' || code.length === 0) return fail('oauth')
      // Login-CSRF guard — see buildAuthUrl for why this matters.
      if (typeof state !== 'string' || !expected || state !== expected) {
        return fail('oauth')
      }

      res.clearCookie(OAUTH_STATE_COOKIE, { path: '/api/auth' })

      try {
        const profile = await getExchanger()(code, redirectUri())
        const user = await authService.upsertGoogleUser(profile)
        const session = await authService.issueSession(user, req.headers['user-agent'])

        res
          .cookie(
            REFRESH_COOKIE,
            session.refreshToken,
            refreshCookieOptions(session.refreshExpiresAt),
          )
          .redirect(new URL('/auth/callback', env().CLIENT_ORIGIN).toString())
      } catch {
        // Never put the underlying reason in a redirect parameter — it lands
        // in browser history and in referrer headers.
        fail('oauth')
      }
    }),
  )

  /* ── Profile — FR-SET-001 ─────────────────────────────────────────────── */

  router.patch(
    '/me',
    requireAuth,
    validateBody(UpdateProfileSchema),
    ah(async (req, res) => {
      const user = await authService.updateProfile(
        assertAuthenticated(req),
        req.body as { displayName?: string; avatarUrl?: string | null },
      )
      res.json({ user: toPublicUser(user) })
    }),
  )

  router.post(
    '/me/password',
    requireAuth,
    validateBody(ChangePasswordSchema),
    ah(async (req, res) => {
      const { currentPassword, newPassword } = req.body as {
        currentPassword?: string
        newPassword: string
      }
      await authService.changePassword(
        assertAuthenticated(req),
        currentPassword,
        newPassword,
      )
      // Every session is gone, including this one, so the cookie goes too.
      res.clearCookie(REFRESH_COOKIE, clearOptions()).status(204).end()
    }),
  )

  router.post(
    '/me/delete',
    requireAuth,
    validateBody(DeleteAccountSchema),
    ah(async (req, res) => {
      const { confirm } = req.body as { confirm: string }
      await authService.deleteAccount(assertAuthenticated(req), confirm)
      res.clearCookie(REFRESH_COOKIE, clearOptions()).status(204).end()
    }),
  )

  return router
}
