import { CircleNotch } from '@phosphor-icons/react'

/**
 * Spinner — the one place in the app a looping animation is correct.
 *
 * R-MOTION-001's frequency gate bans decoration on repeated interactions, but
 * a spinner is not decoration: it is the only signal that the app is working
 * rather than broken. `linear` because constant motion must not appear to
 * stutter (R-MOTION-011).
 */
export function Spinner({
  size = 20,
  className = '',
}: {
  size?: number
  className?: string
}) {
  return (
    <CircleNotch
      size={size}
      weight="light"
      aria-hidden="true"
      className={`animate-spin ${className}`}
      style={{ animationDuration: '900ms', animationTimingFunction: 'linear' }}
    />
  )
}

/**
 * The full-screen state the auth guards show during a silent refresh.
 *
 * FLOWS §2.2: this is what stands between a returning user and a flash of the
 * login screen, so it must render instantly and say something reassuring
 * rather than nothing.
 *
 * `role="status"` + `aria-live="polite"` so a screen reader announces the wait
 * instead of reporting an empty page (R-A11Y-006).
 */
export function FullScreenSpinner({ label }: { label: string }) {
  return (
    <div
      className="flex min-h-[100dvh] w-full flex-col items-center justify-center gap-3 bg-app"
      role="status"
      aria-live="polite"
      data-testid="full-screen-spinner"
    >
      <Spinner size={28} className="text-accent" />
      <p className="text-sm text-muted">{label}</p>
    </div>
  )
}
