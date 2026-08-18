import type { ReactNode } from 'react'

/**
 * EmptyState — the three empty dashboards and the empty Trash, FLOWS §6.3.
 *
 * One component, four sets of copy, all imported from `strings.ts` rather than
 * written here (`R-UI-052`). The distinction FLOWS insists on is between "you
 * have never had boards" and "your filter matched nothing": the first offers
 * creation, the second offers a way back out. Collapsing them into one "no
 * boards" screen tells a user with forty boards that they have none.
 *
 * No animation. An empty state is not an event.
 */
export function EmptyState({
  headline,
  body,
  action,
  testId,
}: {
  headline: string
  body?: string
  action?: ReactNode
  testId: string
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-app px-6 py-20 text-center"
      data-testid={testId}
    >
      <p className="text-base font-medium text-primary">{headline}</p>
      {body ? <p className="max-w-sm text-sm text-muted">{body}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  )
}
