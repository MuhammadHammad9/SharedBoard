import { Check, X } from '@phosphor-icons/react'
import { PASSWORD_MIN_LENGTH } from '@coboard/shared'
import { auth } from '../../lib/strings.js'

/**
 * Live strength meter and checklist — FLOWS §3.1 step 5.
 *
 * The checklist is the important half. A bare strength bar tells the user
 * "weak" without telling them what to do about it, which fails PRD §8.1's
 * "every error tells the user what to do next". The three rules are exactly
 * the three the server enforces, so the user is never surprised at submit.
 *
 * Phosphor Check/X glyphs, never emoji — R-UI-012. Colour is never the only
 * signal either: the glyph itself differs, so this reads correctly in
 * greyscale and to anyone with a colour-vision deficiency.
 */

export interface PasswordRules {
  length: boolean
  letter: boolean
  number: boolean
}

export function checkPassword(password: string): PasswordRules {
  return {
    length: password.length >= PASSWORD_MIN_LENGTH,
    letter: /[A-Za-z]/.test(password),
    number: /[0-9]/.test(password),
  }
}

export type Strength = 'weak' | 'fair' | 'strong'

/**
 * Strength from the rules met plus a length bonus.
 *
 * Deliberately simple, and deliberately not entropy-based: the meter's job is
 * to reflect the SAME rules the form enforces. A clever estimator that calls
 * a valid password "weak" just teaches people to distrust the meter.
 */
export function strengthOf(password: string): Strength {
  const rules = checkPassword(password)
  const met = Number(rules.length) + Number(rules.letter) + Number(rules.number)
  if (met < 3) return 'weak'
  return password.length >= 12 ? 'strong' : 'fair'
}

const BAR: Record<Strength, { width: string; colour: string }> = {
  weak: { width: '33%', colour: 'bg-danger' },
  fair: { width: '66%', colour: 'bg-warning' },
  strong: { width: '100%', colour: 'bg-success' },
}

export function PasswordStrength({ password }: { password: string }) {
  const rules = checkPassword(password)
  const strength = strengthOf(password)
  const bar = BAR[strength]

  const items: Array<[keyof PasswordRules, string]> = [
    ['length', auth.signup.checklist.length],
    ['letter', auth.signup.checklist.letter],
    ['number', auth.signup.checklist.number],
  ]

  return (
    <div className="flex flex-col gap-2" data-testid="password-strength">
      <div className="h-1 w-full overflow-hidden rounded-full bg-border">
        {/*
         * Animated with transform, not width — R-MOTION-040. Animating width
         * lays out on every frame; a scaled transform is composited.
         * `origin-left` so it grows from the start of the track.
         */}
        <div
          className={`h-full origin-left rounded-full transition-transform duration-200 ease-out ${bar.colour}`}
          style={{
            width: '100%',
            transform: `scaleX(${password.length === 0 ? 0 : parseFloat(bar.width) / 100})`,
          }}
        />
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {items.map(([key, label]) => (
          <span
            key={key}
            data-testid={`rule-${key}`}
            data-met={rules[key] ? 'true' : 'false'}
            className={`inline-flex items-center gap-1 text-xs ${
              rules[key] ? 'text-success' : 'text-muted'
            }`}
          >
            {rules[key] ? (
              <Check size={12} weight="bold" aria-hidden="true" />
            ) : (
              <X size={12} weight="bold" aria-hidden="true" />
            )}
            {label}
          </span>
        ))}
      </div>

      {/*
       * Announced politely, so a screen-reader user hears the level change
       * without the checklist being read out on every keystroke.
       */}
      <span className="sr-only" role="status" aria-live="polite">
        {password.length > 0 ? auth.signup.strength[strength] : ''}
      </span>
    </div>
  )
}
