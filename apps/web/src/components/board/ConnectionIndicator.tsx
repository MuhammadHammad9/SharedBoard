import type { ConnectionState } from '@coboard/shared'
import { actions, errors } from '../../lib/strings.js'

/**
 * The connection state, in the board header — `FR-RT-009`, FLOWS §15.2.
 *
 * Every state the machine can be in maps to exactly one rendering here, so a
 * user never has to open the console to know whether their work is safe:
 *
 *   connected     green dot, no text
 *   connecting    amber, pulsing     "Connecting…"
 *   reconnecting  amber, pulsing     "Reconnecting… (attempt N)"
 *   syncing       blue               "Syncing N changes…"
 *   offline       red                "Offline — your changes are saved…"  [Retry now]
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  CONNECTED IS A DOT WITH NO TEXT, AND THAT IS THE DESIGN.                │
 * │                                                                          │
 * │  Working is the default. A permanent "Connected" label in a header the   │
 * │  user stares at for an hour is a word that never changes and therefore   │
 * │  never gets read — and it makes the one state that matters, the broken   │
 * │  one, harder to notice because the shape of the header stays the same.   │
 * │  Text appears only when something is wrong.                              │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * SYNCING WITH NOTHING TO SEND reads "Connecting…": on a first open the
 * rejoin passes through SYNCING for a few milliseconds with an empty outbox,
 * and "Syncing 0 changes…" would be a status about nothing.
 *
 * MOTION: the amber dot pulses — the only continuous animation permitted in
 * the board chrome (§10.2), because a static amber dot is indistinguishable
 * from a broken green one. `opacity` only. The dot's colour change is a
 * 200 ms colour transition; the width is never animated (R-MOTION-040).
 * Reduced motion drops the pulse and keeps the colour, which explains
 * something (R-MOTION-060). Colour is never the only signal: every
 * non-connected state carries text (R-A11Y-007).
 */

export interface ConnectionIndicatorProps {
  state: ConnectionState
  /** The reconnect attempt in flight, from 1. */
  attempt?: number
  /** Changes not yet acknowledged by the server. */
  pending?: number
  /** "Retry now" — restarts the backoff from attempt 1. */
  onRetry?: () => void
}

type Tone = 'success' | 'warning' | 'accent' | 'danger' | 'muted'

const DOT: Record<Tone, string> = {
  success: 'bg-success',
  warning: 'bg-warning motion-safe:animate-pulse-dot',
  accent: 'bg-accent',
  danger: 'bg-danger',
  muted: 'bg-muted',
}

/** What to show for a state. Exported for the tests. */
export function describeConnection(
  state: ConnectionState,
  attempt = 0,
  pending = 0,
): { tone: Tone; label: string | null; srLabel: string } {
  switch (state) {
    case 'connected':
      return { tone: 'success', label: null, srLabel: 'Connected' }
    case 'connecting':
      return { tone: 'warning', label: 'Connecting…', srLabel: 'Connecting…' }
    case 'syncing':
      return pending > 0
        ? {
            tone: 'accent',
            label: errors.syncing(pending),
            srLabel: errors.syncing(pending),
          }
        : { tone: 'warning', label: 'Connecting…', srLabel: 'Connecting…' }
    case 'reconnecting': {
      const label = errors.reconnecting(Math.max(attempt, 1))
      return { tone: 'warning', label, srLabel: label }
    }
    case 'offline':
      return { tone: 'danger', label: errors.disconnected, srLabel: errors.disconnected }
    case 'disconnected':
      return { tone: 'muted', label: null, srLabel: 'Disconnected' }
  }
}

export function ConnectionIndicator({
  state,
  attempt = 0,
  pending = 0,
  onRetry,
}: ConnectionIndicatorProps) {
  const { tone, label, srLabel } = describeConnection(state, attempt, pending)

  return (
    <div
      className="pointer-events-auto flex max-w-[28rem] items-center gap-2 rounded-md bg-app/90 px-2 py-1 shadow-panel"
      data-testid="connection-indicator"
      data-state={state}
      data-tone={tone}
      // A live region: a connection dropping is something a screen-reader user
      // must be told about, and it happens without them doing anything.
      role="status"
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        className={`h-2 w-2 shrink-0 rounded-full transition-colors duration-base ease-standard ${DOT[tone]}`}
      />
      {/* Visible text when there is something to say; an accessible-only
          label when there is not, so the dot is never colour-alone. */}
      {label ? (
        <span className="text-xs text-muted" data-testid="connection-label">
          {label}
        </span>
      ) : (
        <span className="sr-only">{srLabel}</span>
      )}
      {state === 'offline' && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 cursor-pointer rounded-sm text-xs font-medium text-accent outline-none transition-transform duration-fast ease-out hover:underline active:scale-[0.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          data-testid="connection-retry"
        >
          {actions.retryNow}
        </button>
      )}
    </div>
  )
}
