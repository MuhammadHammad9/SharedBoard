import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Spinner } from './Spinner.js'

/**
 * The product's button — PRD §15 tokens, `emil-design-eng` press feedback.
 *
 * MOTION, and the one interesting decision here: the loading state is a
 * CROSSFADE WITH A BLUR MASK rather than a swap.
 *
 * Label and spinner are both rendered, stacked, and cross-faded over 200 ms
 * with `filter: blur(2px)` on the outgoing content. Without the blur you see
 * two legible strings overlapping mid-transition, which reads as a glitch;
 * the blur makes the eye accept it as one thing becoming another
 * (`emil-design-eng`). Kept at 2 px — blur is expensive, especially in Safari.
 *
 * The button also keeps its width while loading. Swapping "Create account"
 * for a spinner would collapse it to 40 px and shift everything below.
 */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  children: ReactNode
  variant?: Variant
  loading?: boolean
  fullWidth?: boolean
}

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:bg-accent/90 focus-visible:outline-accent',
  secondary:
    'border border-border bg-app text-primary hover:bg-subtle focus-visible:outline-accent',
  ghost: 'text-primary hover:bg-subtle focus-visible:outline-accent',
  danger: 'bg-danger text-white hover:bg-danger/90 focus-visible:outline-danger',
}

export function Button({
  children,
  variant = 'primary',
  loading = false,
  fullWidth = false,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      // Disabled WHILE LOADING only. FLOWS §3.2: "Submit is never disabled for
      // validation reasons — let the user click and show them what is wrong."
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={
        'relative inline-flex h-10 items-center justify-center gap-2 rounded-sm px-4 ' +
        'text-sm font-medium cursor-pointer ' +
        'transition-[background-color,color,transform] duration-fast ease-standard ' +
        'active:scale-[0.97] ' +
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
        'disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100 ' +
        (fullWidth ? 'w-full ' : '') +
        VARIANTS[variant]
      }
    >
      {/* Holds the width so the button cannot resize when the label leaves. */}
      <span
        aria-hidden={loading || undefined}
        className="transition-[opacity,filter] duration-200 ease-out"
        style={loading ? { opacity: 0, filter: 'blur(2px)' } : { opacity: 1 }}
      >
        {children}
      </span>

      <span
        className="absolute inset-0 flex items-center justify-center transition-[opacity,filter] duration-200 ease-out"
        style={loading ? { opacity: 1 } : { opacity: 0, filter: 'blur(2px)' }}
        aria-hidden={!loading || undefined}
      >
        <Spinner size={16} />
      </span>
    </button>
  )
}
