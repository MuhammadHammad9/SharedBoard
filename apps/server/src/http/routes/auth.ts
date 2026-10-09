import { randomBytes } from 'node:crypto'
import { Router, type CookieOptions, type Request, type Response } from 'express'
import { z } from 'zod'
import {
  ChangePasswordSchema,
  DeleteAccountSchema,
  EMAIL_VERIFICATION_TTL_MS,
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
import { logger } from '../../lib/logger.js'
import { assertAuthenticated, requireAuth } from '../middleware/auth.js'
import { ah, HttpError } from '../middleware/errorHandler.js'
import { validateBody } from '../middleware/validate.js'
import {
  assertLoginAllowed,
  clearLoginAttempts,
  clientIp,
  limitByIp,
} from '../middleware/rateLimit.js'
import { memberService } from '../../services/MemberService.js'

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

const VerifyEmailSchema = z.object({ token: z.string().min(1).max(512) })

/**
 * D-22: a password registration whose address has invites waiting gets a
 * verification link. No invites, no email — there is nothing to unlock.
 */
async function sendVerificationIfInvited(userId: string): Promise<void> {
  const user = await authService.findById(userId)
  if (!user || user.emailVerifiedAt) return
  if (!(await memberService.hasPendingInvites(user.emailLower))) return
  const token = await authService.createEmailVerification(user)
  const url = new URL('/verify-email', env().CLIENT_ORIGIN)
  url.searchParams.set('token', token)
  await getMailer().sendEmailVerification({
    to: user.email,
    displayName: user.displayName,
    verifyUrl: url.toString(),
    expiresInHours: EMAIL_VERIFICATION_TTL_MS / 3_600_000,
  })
}

export function createAuthRouter(): Router {
  const router = Router()

  /* ── POST /auth/register ──────────────────────────────────────────────── */

  router.post(
    '/register',
    limitByIp('register', env().REGISTER_RATE_LIMIT),
    validateBody(RegisterSchema),
    ah(async (req, res) => {
      const session = await authService.register({
        ...(req.body as { email: string; password: string; displayName: string }),
        userAgent: req.headers['user-agent'],
      })
      /*
       * D-22: invites are NOT claimed here. Typing an address into a signup
       * form proves nothing about owning it, and claiming at registration let
       * anyone who knew an invitee's address take their seat on the board.
       * When invites are waiting, the address gets a verification link; the
       * invites are claimed when it is opened (POST /verify-email).
       *
       * In the background, like forgot-password: the response must not take
       * longer for an address with pending invites than for one without.
       */
      void sendVerificationIfInvited(session.user.id).catch(err =>
        logger.error({ err, userId: session.user.id }, 'verification email failed'),
      )
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
      await clearLoginAttempts(email, clientIp(req))

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

      /*
       * Finding 12: the work happens AFTER the response, for both branches.
       * Awaited, an existing account cost a token insert plus an SMTP round
       * trip and a missing one cost a single SELECT — an enumeration oracle
       * readable with a stopwatch, whatever the body said. Failures are
       * logged; the caller was never going to be told either way.
       */
      void (async () => {
        const created = await authService.createPasswordReset(email)
        if (!created) return
        const url = new URL('/reset-password', env().CLIENT_ORIGIN)
        url.searchParams.set('token', created.token)
        await getMailer().sendPasswordReset({
          to: created.user.email,
          displayName: created.user.displayName,
          resetUrl: url.toString(),
          expiresInMinutes: PASSWORD_RESET_TTL_MS / 60_000,
        })
      })().catch(err => logger.error({ err }, 'password reset email failed'))

      /*
       * 200 either way — R-SEC-008. The response must be identical whether or
       * not the account exists, or this endpoint is a free account-enumeration
       * oracle for anyone with a word list.
       */
      res.status(200).json({ ok: true })
    }),
  )

  /* ── Email verification — D-22 ──────────────────────────────────────── */

  /**
   * Open the emailed link: the address is proven, THEN the invites waiting
   * for it are claimed — in that order, so a claim never happens for an
   * address nobody has shown they own. No session is issued; the token proves
   * a mailbox, not a password.
   */
  router.post(
    '/verify-email',
    limitByIp('verify-email', 20),
    validateBody(VerifyEmailSchema),
    ah(async (req, res) => {
      const { token } = req.body as z.infer<typeof VerifyEmailSchema>
      const user = await authService.verifyEmail(token)
      const claimed = await memberService.claimInvites(user.id, user.emailLower)
      res.status(200).json({ ok: true, claimed })
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
        // Claimed for a brand-new Google account and for an existing one
        // alike — but only when Google vouched for the address (D-22). An
        // unverified Google email proves no more than a typed one.
        if (user.emailVerifiedAt) {
          await memberService.claimInvites(user.id, user.emailLower)
        }
        const session = await authService.issueSession(user, req.headers['user-agent'])
        // `?created=1` only tells the client which PRD §9 event to send
        // (account_created vs logged_in). Nothing personal in the URL.
        const callback = new URL('/auth/callback', env().CLIENT_ORIGIN)
        if (user.created) callback.searchParams.set('created', '1')

        res
          .cookie(
            REFRESH_COOKIE,
            session.refreshToken,
            refreshCookieOptions(session.refreshExpiresAt),
          )
          .redirect(callback.toString())
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
