import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Button } from './Button.js'
import { actions } from '../../lib/strings.js'
import { useAuthStore } from '../../stores/authStore.js'

/**
 * The full-screen states — S-19 (no access), S-20 (not found), S-21 (error),
 * FLOWS §12.
 *
 * One component for all of them, because the layout and the accessibility
 * behaviour are identical and only the copy differs. Copy is passed in from
 * `strings.ts` and never inlined here (R-UI-052): the same sentence appears in
 * a toast elsewhere, and two copies of a string drift.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  R-SEC-018: the caller MUST NOT pass a board name into `headline` or     │
 * │  `body` on the access-denied variant. Confirming that a board exists —   │
 * │  and what it is called — to someone who was refused is the leak this     │
 * │  screen exists to avoid.                                                 │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * `role="alert"` rather than a bare heading, so a screen reader announces the
 * outcome instead of leaving the user on a page that silently changed.
 *
 * No animation. This screen appears when something has already gone wrong, and
 * an entrance flourish on a failure is the wrong register entirely.
 */
export function FullScreenState({
  headline,
  body,
  action,
  footer,
  overlay = false,
  testId,
}: {
  headline: string
  /** Optional: some states are one sentence (the unsupported browser). */
  body?: string
  action?: ReactNode
  /** A quieter line under the action — S-17's "Signed in as …". */
  footer?: ReactNode
  /**
   * Over a frozen board rather than instead of it (S-19, FLOWS §12.3). The
   * board stays visible, dimmed, behind the message.
   */
  overlay?: boolean
  testId: string
}) {
  return (
    <div
      className={`flex w-full flex-col items-center justify-center gap-3 px-6 text-center ${
        overlay ? 'absolute inset-0 z-modal bg-app/90' : 'min-h-[100dvh] bg-app'
      }`}
      role="alert"
      data-testid={testId}
    >
      <h1 className="text-lg font-semibold text-primary">{headline}</h1>
      {body ? <p className="max-w-sm text-sm text-muted">{body}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
      {footer ? <div className="mt-4 text-sm text-muted">{footer}</div> : null}
    </div>
  )
}

/** The action every board-level failure offers — FLOWS §12. */
export function BackToDashboard({ label }: { label: string }) {
  return (
    <Link to="/dashboard">
      <Button variant="secondary">{label}</Button>
    </Link>
  )
}

/**
 * Where "out" is for whoever is looking — FLOWS §1.2.
 *
 * A signed-in user's home is S-07. Anyone else — a guest, or an anonymous
 * visitor — has no dashboard (FR-AUTH-006), and `/dashboard` would only bounce
 * them to a login form they never asked for, so their way out is S-01. The
 * §1.2 table says this for S-10's back arrow and S-17; D-31 extends it to
 * S-18 and S-19, which name only the dashboard.
 */
export function useHomeExit(): { to: '/dashboard' | '/'; label: string } {
  const authed = useAuthStore(s => s.status === 'authenticated')
  return authed
    ? { to: '/dashboard', label: actions.backToDashboard }
    : { to: '/', label: actions.backToHome }
}

/** S-17 / S-18 / S-19's button: "Back to dashboard", or "Back to home" for a guest. */
export function BackHome() {
  const exit = useHomeExit()
  return (
    <Link to={exit.to} data-testid="back-home">
      <Button variant="secondary">{exit.label}</Button>
    </Link>
  )
}
