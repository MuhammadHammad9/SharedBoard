import { useEffect, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'
import { getAccessToken, useAuthStore } from '../stores/authStore.js'
import { api, attemptSilentRefresh } from '../lib/api.js'
import { FullScreenSpinner } from '../components/ui/Spinner.js'
import { loginUrlFor } from './nextParam.js'
import type { PublicUser } from '@coboard/shared'

/**
 * Route guards — FLOWS §2.2.
 *
 * The sequence is specified exactly, and the third step is the one that
 * matters:
 *
 *   1. Access token in memory?  → proceed.
 *   2. No?                      → silent refresh, showing a SPINNER.
 *   3. Refresh succeeds         → proceed.
 *      Refresh fails            → /login?next=<where they were going>
 *
 * "Do NOT flash the login screen. A flash of login is a bug, not a cosmetic
 * issue." Every cold load with a valid 30-day cookie passes through step 2,
 * because the access token lives in memory and memory does not survive a
 * refresh. Rendering `<Login/>` while that request is in flight would mean
 * every returning user sees a login form they never needed — which reads as
 * "I have been logged out" even though they have not been.
 *
 * The `unknown` status exists purely to make that state representable. A
 * boolean `isAuthenticated` cannot distinguish "not logged in" from "we have
 * not looked yet", and collapsing the two is exactly how the flash appears.
 */

/**
 * Runs the silent refresh exactly once per page load.
 *
 * The `started` flag is a module variable rather than a dependency-array
 * guard, and that is not a style preference — it is the fix for a real bug.
 *
 * The obvious version keys the effect on `status` and bails when it is no
 * longer 'unknown'. But the effect's FIRST action is to set status to
 * 'refreshing', which changes the dependency, which runs the cleanup, which
 * cancels the request that was just started. The status then never leaves
 * 'refreshing' and the guard shows its spinner forever.
 *
 * A module-level flag also gives the behaviour we actually want: two guards
 * mounting at once, or a remount under StrictMode, share one bootstrap rather
 * than racing two.
 */
let bootstrapStarted = false

/** Tests reset this between cases; nothing else should touch it. */
export function resetSessionBootstrap(): void {
  bootstrapStarted = false
}

function useSessionBootstrap(): void {
  const setStatus = useAuthStore(s => s.setStatus)
  const setSession = useAuthStore(s => s.setSession)
  const clear = useAuthStore(s => s.clear)

  useEffect(() => {
    if (bootstrapStarted) return
    bootstrapStarted = true

    setStatus('refreshing')

    void (async () => {
      const refreshed = await attemptSilentRefresh()
      if (!refreshed) {
        clear()
        return
      }

      /*
       * The refresh gave us a token but the store still has no user, so ask
       * who it belongs to. Without this the dashboard renders with a valid
       * session and an empty avatar.
       */
      try {
        const { user } = await api.get<{ user: PublicUser }>('/auth/me')
        // `attemptSilentRefresh` already stored the token; read it back rather
        // than threading it through, so there is one writer.
        setSession(user, getAccessToken() ?? '')
      } catch {
        clear()
      }
    })()
    // Deliberately empty: this must run once for the page, not once per
    // status change. See the note above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

interface GuardProps {
  children: ReactNode
}

export function RequireAuth({ children }: GuardProps) {
  useSessionBootstrap()
  const status = useAuthStore(s => s.status)
  const location = useLocation()

  // Steps 1–2. A spinner, never the login screen.
  if (status === 'unknown' || status === 'refreshing') {
    return <FullScreenSpinner label="Loading your boards" />
  }

  if (status === 'anonymous') {
    // Step 4's `?next=` is captured HERE, from where the user was actually
    // heading, including its query string.
    return <Navigate to={loginUrlFor(location.pathname, location.search)} replace />
  }

  return <>{children}</>
}

/**
 * The inverse: keep an authenticated user off the login and signup screens.
 *
 * Same spinner rule. Rendering the login form during the refresh and then
 * yanking it away is the flash again, just from the other direction.
 */
export function RedirectIfAuthed({ children }: GuardProps) {
  useSessionBootstrap()
  const status = useAuthStore(s => s.status)

  if (status === 'unknown' || status === 'refreshing') {
    return <FullScreenSpinner label="Checking your session" />
  }

  if (status === 'authenticated') return <Navigate to="/dashboard" replace />

  return <>{children}</>
}
