import { ERROR_CODES } from '@coboard/shared'
import { AuthError } from '../services/AuthService.js'
import { env, googleConfigured } from './env.js'

/**
 * Google OAuth 2.0 — FR-AUTH-003 [P1].
 *
 * Scope note, stated plainly rather than implied: this repository has no
 * Google client credentials and none can be created from here, so the live
 * round-trip against accounts.google.com is **unverified**. What IS verified,
 * by integration test, is everything on our side of the boundary — the
 * redirect URL's shape, state validation, and the account-linking rules in
 * `AuthService.upsertGoogleUser`, which are where the security-relevant
 * decisions actually live.
 *
 * That is what the `TokenExchanger` interface is for. The HTTP call to Google
 * is one injectable function; tests substitute it and drive every branch of
 * the linking logic against a real database. Without the seam the only way to
 * test linking would be to mock Prisma, which would test nothing.
 */

export interface GoogleProfile {
  googleId: string
  email: string
  emailVerified: boolean
  displayName: string
  avatarUrl?: string | null
}

/** Exchanges an authorization code for a verified profile. */
export type TokenExchanger = (code: string, redirectUri: string) => Promise<GoogleProfile>

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

export function redirectUri(): string {
  return (
    env().GOOGLE_REDIRECT_URI ?? `http://localhost:${env().PORT}/api/auth/google/callback`
  )
}

/**
 * The consent-screen URL.
 *
 * `state` is a random value the caller also stores in a short-lived cookie and
 * compares on the way back. Without it the callback accepts a code obtained in
 * someone else's browser — login CSRF, where an attacker silently signs the
 * victim into the attacker's account and then reads whatever they create.
 */
export function buildAuthUrl(state: string): string {
  if (!googleConfigured()) {
    throw new AuthError(ERROR_CODES.OAUTH_FAILED, 'Google OAuth is not configured', 503)
  }
  const params = new URLSearchParams({
    client_id: env().GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    // The account chooser rather than a silent re-auth, so a user with several
    // Google accounts is not signed in as whichever one the browser prefers.
    prompt: 'select_account',
  })
  return `${AUTH_ENDPOINT}?${params.toString()}`
}

/** The real exchange. Untested against Google — see the module note. */
export const exchangeCode: TokenExchanger = async (code, uri) => {
  if (!googleConfigured()) {
    throw new AuthError(ERROR_CODES.OAUTH_FAILED, 'Google OAuth is not configured', 503)
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env().GOOGLE_CLIENT_ID!,
      client_secret: env().GOOGLE_CLIENT_SECRET!,
      redirect_uri: uri,
      grant_type: 'authorization_code',
    }),
  })

  if (!response.ok) {
    throw new AuthError(ERROR_CODES.OAUTH_FAILED, 'Google token exchange failed', 400)
  }

  const body = (await response.json()) as { id_token?: string }
  if (!body.id_token) {
    throw new AuthError(ERROR_CODES.OAUTH_FAILED, 'Google returned no id_token', 400)
  }
  return decodeIdToken(body.id_token)
}

/**
 * Read the claims out of an id_token.
 *
 * The signature is NOT verified here, and that is safe for exactly one reason:
 * this token came back over TLS from Google's own token endpoint in a direct
 * server-to-server call, in response to our client_secret. There is no
 * untrusted party in that path.
 *
 * It would be unsafe the moment an id_token arrives from anywhere else — a
 * client posting one, say. If that path is ever added it must verify against
 * Google's JWKS first. Flagged here because this is precisely the shortcut
 * that gets copy-pasted into a context where it is a vulnerability.
 */
export function decodeIdToken(idToken: string): GoogleProfile {
  const [, payload] = idToken.split('.')
  if (!payload) {
    throw new AuthError(ERROR_CODES.OAUTH_FAILED, 'Malformed id_token', 400)
  }

  let claims: Record<string, unknown>
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    throw new AuthError(ERROR_CODES.OAUTH_FAILED, 'Unreadable id_token payload', 400)
  }

  const sub = claims.sub
  const email = claims.email
  if (typeof sub !== 'string' || typeof email !== 'string') {
    throw new AuthError(ERROR_CODES.OAUTH_FAILED, 'id_token missing sub or email', 400)
  }

  return {
    googleId: sub,
    email,
    emailVerified: claims.email_verified === true,
    displayName: typeof claims.name === 'string' ? claims.name : email.split('@')[0]!,
    avatarUrl: typeof claims.picture === 'string' ? claims.picture : null,
  }
}

let exchanger: TokenExchanger = exchangeCode

export const getExchanger = (): TokenExchanger => exchanger
/** Tests substitute the network call; nothing else does. */
export const setExchanger = (fn: TokenExchanger): void => {
  exchanger = fn
}
