import { useAuthStore } from '../../stores/authStore.js'
import { auth } from '../../lib/strings.js'

/**
 * E-17 — the session expired while the board was open.
 *
 * "The socket stays valid for its lifetime. Refresh the token silently in the
 * background. If the refresh fails, keep the socket alive but show a banner:
 * 'Your session expired. [Log in again]' — never lose their work."
 *
 * The last clause is the requirement. The obvious implementation of an expired
 * session is to redirect to /login, and on a board that throws away everything
 * the user has drawn since the token lapsed. So this is a BANNER, not a
 * redirect: the canvas keeps rendering, the socket keeps its connection, and
 * logging back in is offered rather than forced.
 *
 * `api.ts` sets the flag by calling `markSessionExpired` when a refresh fails
 * while the user is authenticated — never for an anonymous 401, which is an
 * ordinary "please log in".
 */
export function SessionExpiredBanner() {
  const expired = useAuthStore(s => s.sessionExpired)
  if (!expired) return null

  const next = `${window.location.pathname}${window.location.search}`

  return (
    <div
      role="alert"
      data-testid="session-expired-banner"
      className={
        'pointer-events-auto absolute left-1/2 top-4 z-toast flex -translate-x-1/2 items-center ' +
        'gap-3 rounded-md border border-warning/40 bg-app px-4 py-2 text-sm text-primary shadow-panel'
      }
    >
      <span>{auth.sessionExpired.message}</span>
      <a
        href={`/login?next=${encodeURIComponent(next)}`}
        className="font-medium text-accent hover:underline"
        data-testid="session-expired-login"
      >
        {auth.sessionExpired.action}
      </a>
    </div>
  )
}
