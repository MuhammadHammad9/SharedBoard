import type { ReactNode } from 'react'
import { Link } from 'react-router'

/**
 * The shell every auth screen sits in — S-02 … S-06.
 *
 * Zone: Auth. Dials 5 / 3 / 4 (`design-taste-frontend`), which is the whole
 * reason this looks calm rather than designed. `gpt-taste` is forbidden here
 * (R-SKILL-010): AIDA structure and hero grammar belong on a landing page, and
 * a person trying to log in is not being persuaded of anything.
 *
 * A single centred column, `max-w-sm`. Two-column auth pages with a marketing
 * panel down one side are the default template, and they push the form
 * off-centre for no benefit to someone who has already decided to sign in.
 *
 * `min-h-[100dvh]`, never `h-screen` — R-UI-041, avoids the iOS Safari
 * address-bar jump that crops the submit button.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string
  subtitle?: string
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <main className="flex min-h-[100dvh] w-full flex-col items-center justify-center bg-subtle px-4 py-12">
      <div className="w-full max-w-sm">
        <Link
          to="/"
          className="mb-8 flex items-center justify-center gap-2 text-lg font-semibold text-primary"
        >
          <span
            aria-hidden="true"
            className="inline-block h-6 w-6 rounded-md bg-accent"
          />
          CoBoard
        </Link>

        <div className="rounded-lg border border-border bg-app p-6 shadow-panel">
          <h1 className="text-xl font-semibold text-primary">{title}</h1>
          {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
          <div className="mt-6">{children}</div>
        </div>

        {footer ? (
          <div className="mt-4 text-center text-sm text-muted">{footer}</div>
        ) : null}
      </div>
    </main>
  )
}

/** The "or" rule between the OAuth button and the email form. */
export function OrDivider({ label }: { label: string }) {
  return (
    <div className="my-4 flex items-center gap-3" aria-hidden="true">
      <span className="h-px flex-1 bg-border" />
      <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}
