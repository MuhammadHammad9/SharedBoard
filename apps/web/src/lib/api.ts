import { ERROR_CODES, type ErrorEnvelope } from '@coboard/shared'
import { authStore, getAccessToken, setAccessToken } from '../stores/authStore.js'

/**
 * The HTTP client — TRD §4, FLOWS §2.2.
 *
 * One job beyond `fetch`: when a request comes back 401 because the 15-minute
 * access token has expired, silently refresh and replay the original request,
 * so a user working across a token boundary sees nothing at all.
 */

const BASE = '/api'

/** A failed request, carrying the server's envelope so callers can switch on `code`. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
    readonly retryAfter?: number,
    readonly correlationId?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }

  /** True when the request never reached the server — FLOWS §3.1 branch 8e. */
  get isNetwork(): boolean {
    return this.status === 0
  }
}

export const NETWORK_ERROR_CODE = 'NETWORK'

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  /** Internal: suppresses the refresh-and-replay, so refresh cannot recurse. */
  skipAuthRetry?: boolean
  signal?: AbortSignal
}

/**
 * A single in-flight refresh, shared by every caller.
 *
 * Without this, a screen that fires four parallel requests just after the
 * token expires sends four refreshes. Three of them present a token the first
 * has already rotated away — which the server correctly reads as REUSE and
 * responds to by revoking the whole family (R-SEC-006). The user is logged out
 * for loading a page.
 *
 * So: the first 401 starts a refresh, everyone else awaits the same promise.
 */
let refreshInFlight: Promise<boolean> | null = null

async function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const response = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      })
      if (!response.ok) return false

      const body = (await response.json()) as { accessToken: string; user?: never }
      setAccessToken(body.accessToken)
      return true
    } catch {
      // Network failure, not a rejected session. The caller decides.
      return false
    } finally {
      // Cleared in `finally` so the NEXT expiry starts a fresh attempt rather
      // than resolving instantly against a stale result.
      refreshInFlight = null
    }
  })()

  return refreshInFlight
}

/** Exposed for the guard, which refreshes before any request is made. */
export async function attemptSilentRefresh(): Promise<boolean> {
  return refreshSession()
}

async function toApiError(response: Response): Promise<ApiError> {
  let envelope: ErrorEnvelope | null = null
  try {
    envelope = (await response.json()) as ErrorEnvelope
  } catch {
    // A non-JSON error body — a proxy 502, say.
  }

  const error = envelope?.error
  return new ApiError(
    error?.code ?? ERROR_CODES.INTERNAL,
    error?.message ?? response.statusText,
    response.status,
    error?.details,
    error?.retryAfter,
    error?.correlationId,
  )
}

export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = 'GET', body, skipAuthRetry = false, signal } = options

  const send = async (): Promise<Response> => {
    const token = getAccessToken()
    return fetch(`${BASE}${path}`, {
      method,
      // Always, so the refresh cookie rides along on the auth routes.
      credentials: 'include',
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    })
  }

  let response: Response
  try {
    response = await send()
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    // FLOWS §3.1 branch 8e: the form must keep the user's typed values and
    // offer Retry, which it can only do if this is distinguishable from a
    // server rejection.
    throw new ApiError(NETWORK_ERROR_CODE, "Couldn't reach the server", 0)
  }

  /*
   * The replay. A 401 here means the access token aged out mid-session, which
   * is expected every 15 minutes and must be invisible.
   *
   * Only retried ONCE, and never for the refresh call itself: a 401 on the
   * second attempt means the refresh genuinely failed, and retrying again
   * would spin.
   */
  if (response.status === 401 && !skipAuthRetry) {
    const refreshed = await refreshSession()
    if (refreshed) {
      response = await send()
    } else {
      setAccessToken(null)
      const { status, sessionExpired } = authStore.getState()
      /*
       * E-17. If the user is mid-session — a board open, work on screen — do
       * NOT tear the app down to a login screen. Mark the session expired so
       * a banner appears and the socket keeps their work alive.
       */
      if (status === 'authenticated' && !sessionExpired) {
        authStore.getState().markSessionExpired()
      }
    }
  }

  if (!response.ok) throw await toApiError(response)

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) =>
    apiRequest<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiRequest<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiRequest<T>(path, { ...options, method: 'PATCH', body }),
  del: <T>(path: string, options?: RequestOptions) =>
    apiRequest<T>(path, { ...options, method: 'DELETE' }),
}
