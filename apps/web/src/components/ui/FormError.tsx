import { useEffect, useRef } from 'react'
import { Warning } from '@phosphor-icons/react'

/**
 * A form-level error banner — FLOWS §3.2.
 *
 * "Form-level errors appear above the submit button and receive focus for
 *  screen readers."
 *
 * Focus, not just `aria-live`, by default: a live region announces the message
 * but leaves the caret where it was, so a screen-reader user who submits and
 * hears "error" has no way to reach it except by re-reading the form.
 *
 * `autoFocus` exists because that rule collides with FLOWS §4 branch 3b, which
 * says a failed login must return focus to the PASSWORD field. Two specified
 * behaviours, one focus. The more specific one wins — see defect D-8 in
 * RULES.md §2.4 — and the banner keeps `role="alert"`, so it is still
 * announced either way. Nothing is lost but the caret position.
 *
 * MOTION: opacity + translateY(-8px) → 0 over 200 ms, --ease-out. Occasional
 * band on the frequency gate (R-MOTION-001), so a standard entrance is right;
 * ease-out because the user is watching the arrival (R-MOTION-010).
 */
export function FormError({
  message,
  action,
  autoFocus = true,
}: {
  message: string
  action?: React.ReactNode
  autoFocus?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [message, autoFocus])

  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      data-form-error=""
      data-testid="form-error"
      className={
        'flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 ' +
        'text-sm text-danger outline-none focus-visible:outline focus-visible:outline-2 ' +
        'focus-visible:outline-danger'
      }
    >
      <Warning size={16} weight="light" aria-hidden="true" className="mt-0.5 shrink-0" />
      <div className="flex-1">
        {message}
        {action ? <div className="mt-1">{action}</div> : null}
      </div>
    </div>
  )
}
