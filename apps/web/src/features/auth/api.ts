import type { AuthResponse, PublicUser } from '@coboard/shared'
import { api } from '../../lib/api.js'
import { authStore } from '../../stores/authStore.js'

/**
 * Auth API calls — the thin layer between the screens and `api.ts`.
 *
 * Each function commits the result to the store, so no screen has to remember
 * to. A component that calls `login()` and forgets `setSession` is a component
 * that authenticates the user and then shows them the login page.
 */

export async function register(input: {
  email: string
  password: string
  displayName: string
}): Promise<PublicUser> {
  const result = await api.post<AuthResponse>('/auth/register', input)
  authStore.getState().setSession(result.user, result.accessToken)
  return result.user
}

export async function login(input: {
  email: string
  password: string
}): Promise<PublicUser> {
  const result = await api.post<AuthResponse>('/auth/login', input)
  authStore.getState().setSession(result.user, result.accessToken)
  return result.user
}

/**
 * Log out — FR-AUTH-007, task 19.
 *
 * The order is deliberate: disconnect the socket FIRST, then revoke the
 * session server-side, then clear local state. Reversed, the socket would
 * still be open with a session the server has already killed, and Phase 9's
 * gateway would be forced to handle a stream of ops from a logged-out user.
 */
export async function logout(): Promise<void> {
  // PHASE 9 SLOT: socketClient.disconnect() belongs here, before the revoke.
  try {
    await api.post<void>('/auth/logout')
  } catch {
    // A failed logout must still clear the client. Leaving the user looking
    // logged in because the network hiccuped is worse than a stale row.
  }
  authStore.getState().clear()
}

export const forgotPassword = (email: string) =>
  api.post<{ ok: true }>('/auth/forgot-password', { email })

export const validateResetToken = (token: string) =>
  api.get<{ valid: true }>(`/auth/reset/validate?token=${encodeURIComponent(token)}`)

export const resetPassword = (token: string, password: string) =>
  api.post<{ ok: true }>('/auth/reset', { token, password })

export async function updateProfile(patch: {
  displayName?: string
  avatarUrl?: string | null
}): Promise<PublicUser> {
  const { user } = await api.patch<{ user: PublicUser }>('/auth/me', patch)
  authStore.getState().setUser(user)
  return user
}

export async function changePassword(input: {
  currentPassword?: string
  newPassword: string
}): Promise<void> {
  await api.post<void>('/auth/me/password', input)
  // The server revoked every session, including this one — so the client must
  // agree, rather than holding a token that will 401 on its next use.
  authStore.getState().clear()
}

export async function deleteAccount(confirm: string): Promise<void> {
  await api.post<void>('/auth/me/delete', { confirm })
  authStore.getState().clear()
}

/** FLOWS §3.3: stash `next` before leaving the SPA for Google. */
export const OAUTH_NEXT_KEY = 'coboard.oauth.next'

export function startGoogleOAuth(next: string | null): void {
  try {
    if (next) sessionStorage.setItem(OAUTH_NEXT_KEY, next)
  } catch {
    // E-18: private mode can block storage. The user simply lands on the
    // dashboard instead of their deep link — degraded, not broken.
  }
  window.location.assign('/api/auth/google')
}
