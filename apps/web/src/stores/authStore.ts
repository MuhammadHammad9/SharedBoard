import { create } from 'zustand'
import type { PublicUser } from '@coboard/shared'

/**
 * Authentication state — TRD §11.1, R-SEC-005 (Blocking).
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  THE ACCESS TOKEN LIVES IN MEMORY. NEVER IN localStorage.            │
 * │                                                                      │
 * │  Any XSS on any page can read localStorage and exfiltrate whatever   │
 * │  is in it. A module variable dies with the tab and cannot be read    │
 * │  by a script that did not already have execution in this frame.      │
 * │                                                                      │
 * │  The cost is that a refresh loses the token — which is precisely     │
 * │  what the httpOnly refresh cookie and the silent-refresh guard in    │
 * │  routes/guards.tsx exist to paper over, invisibly.                   │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * The token is held OUTSIDE the store as well, in a plain module variable.
 * That is not duplication for its own sake: `api.ts` needs to read the current
 * token synchronously on every request and to replace it mid-flight during a
 * refresh, and routing that through React state would make the interceptor
 * depend on a render having happened.
 */

/** The live access token. Read by api.ts; never serialised anywhere. */
let accessToken: string | null = null

export const getAccessToken = (): string | null => accessToken
export const setAccessToken = (token: string | null): void => {
  accessToken = token
}

export type AuthStatus =
  /** Cold start: we do not yet know whether there is a session. */
  | 'unknown'
  /** A silent refresh is in flight. The guard shows a spinner, NOT the login screen. */
  | 'refreshing'
  | 'authenticated'
  | 'anonymous'

interface AuthState {
  status: AuthStatus
  user: PublicUser | null
  /**
   * E-17: the session expired while the board was open. The socket stays
   * alive and the work is untouched; a banner offers a re-login. Distinct
   * from `anonymous`, which means "show the login screen".
   */
  sessionExpired: boolean

  setSession: (user: PublicUser, token: string) => void
  setUser: (user: PublicUser) => void
  setStatus: (status: AuthStatus) => void
  markSessionExpired: () => void
  clear: () => void
}

export const useAuthStore = create<AuthState>(set => ({
  status: 'unknown',
  user: null,
  sessionExpired: false,

  setSession: (user, token) => {
    setAccessToken(token)
    set({ user, status: 'authenticated', sessionExpired: false })
  },

  setUser: user => set({ user }),

  setStatus: status => set({ status }),

  markSessionExpired: () => {
    // The token is dropped but the user object is kept, so the banner can say
    // who to log back in as and the board keeps rendering their work.
    setAccessToken(null)
    set({ sessionExpired: true })
  },

  clear: () => {
    setAccessToken(null)
    set({ user: null, status: 'anonymous', sessionExpired: false })
  },
}))

/** Non-React read, for modules that must not subscribe. */
export const authStore = useAuthStore
