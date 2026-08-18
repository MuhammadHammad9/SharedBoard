import {
  forwardRef,
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react'
import { Eye, EyeSlash } from '@phosphor-icons/react'

/**
 * The text input every form in the product uses — FLOWS §3.2.
 *
 * The label is always rendered, never replaced by a placeholder. A
 * placeholder-as-label vanishes the moment the user types, so anyone who is
 * interrupted mid-form comes back to a row of unlabelled boxes — and it is
 * invisible to a screen reader. `ui-ux-pro-max`, R-A11Y-002.
 *
 * MOTION: the inline error slides in over 150 ms with --ease-out. The input
 * border colour transitions; nothing moves the field itself, because a field
 * that shifts as you leave it makes the next click land somewhere else.
 */

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  label: string
  /** Shown below the field, in danger colour, with aria-invalid set. */
  error?: string | null
  /** Persistent helper text. Hidden while an error is showing. */
  hint?: ReactNode
  /** Renders a show/hide toggle — FLOWS §3.1 step 5. */
  revealable?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, hint, revealable = false, type = 'text', id, ...rest },
  ref,
) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const errorId = `${inputId}-error`
  const hintId = `${inputId}-hint`
  const [revealed, setRevealed] = useState(false)

  const effectiveType = revealable ? (revealed ? 'text' : 'password') : type

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-primary">
        {label}
      </label>

      <div className="relative">
        <input
          {...rest}
          ref={ref}
          id={inputId}
          type={effectiveType}
          aria-invalid={error ? true : undefined}
          // Points at whichever of the two is actually rendered, so the
          // description a screen reader hears matches what is on screen.
          aria-describedby={error ? errorId : hint ? hintId : undefined}
          className={
            'h-10 w-full rounded-sm border bg-app px-3 text-sm text-primary ' +
            'transition-colors duration-fast ease-standard ' +
            'placeholder:text-muted focus-visible:outline focus-visible:outline-2 ' +
            'focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60 ' +
            (revealable ? 'pr-10 ' : '') +
            (error
              ? 'border-danger focus-visible:outline-danger'
              : 'border-border focus-visible:outline-accent')
          }
        />

        {revealable ? (
          <button
            type="button"
            // Not in the tab order: it is a convenience, and tabbing from the
            // password field should reach the submit button, not a toggle.
            tabIndex={-1}
            onClick={() => setRevealed(v => !v)}
            aria-label={revealed ? 'Hide password' : 'Show password'}
            aria-pressed={revealed}
            data-testid="reveal-password"
            className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer rounded-sm p-1 text-muted transition-colors duration-fast ease-standard hover:text-primary"
          >
            {revealed ? (
              <EyeSlash size={16} weight="light" aria-hidden="true" />
            ) : (
              <Eye size={16} weight="light" aria-hidden="true" />
            )}
          </button>
        ) : null}
      </div>

      {error ? (
        <p id={errorId} data-field-error="" className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <div id={hintId} className="text-xs text-muted">
          {hint}
        </div>
      ) : null}
    </div>
  )
})
