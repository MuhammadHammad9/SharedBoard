import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Button } from './Button.js'

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
  testId,
}: {
  headline: string
  body: string
  action?: ReactNode
  testId: string
}) {
  return (
    <div
      className="flex min-h-[100dvh] w-full flex-col items-center justify-center gap-3 bg-app px-6 text-center"
      role="alert"
      data-testid={testId}
    >
      <h1 className="text-lg font-semibold text-primary">{headline}</h1>
      <p className="max-w-sm text-sm text-muted">{body}</p>
      {action ? <div className="mt-2">{action}</div> : null}
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
