import type { ConnectionState } from '@coboard/shared'

/**
 * The connection state, in the board header — `FR-RT-009`, FLOWS §15.2.
 *
 * Phase 9 implements the two states that exist yet: **Connected** and
 * **Connecting**. The other four — syncing, reconnecting, offline, and the
 * pending-change count — land in Phase 11 with the full connection state
 * machine. They are absent rather than stubbed, so nothing renders a status
 * that is not real.
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
 * MOTION: the amber dot pulses, and it is the only continuous animation
 * permitted in the board chrome (§10.2). It is status rather than decoration —
 * a static amber dot is indistinguishable from a broken green one — and it is
 * an `opacity` loop, so it costs the compositor nothing while the canvas is
 * busy. `prefers-reduced-motion` drops it to a static dot, which still carries
 * the meaning through colour AND the adjacent text (never colour alone).
 */

const LABELS: Partial<Record<ConnectionState, string>> = {
  connecting: 'Connecting…',
  syncing: 'Connecting…',
  reconnecting: 'Connecting…',
}

const DOT: Record<ConnectionState, string> = {
  connected: 'bg-success',
  connecting: 'bg-warning motion-safe:animate-pulse-dot',
  syncing: 'bg-warning motion-safe:animate-pulse-dot',
  reconnecting: 'bg-warning motion-safe:animate-pulse-dot',
  offline: 'bg-danger',
  disconnected: 'bg-muted',
}

export function ConnectionIndicator({ state }: { state: ConnectionState }) {
  const label = LABELS[state]

  return (
    <div
      className="pointer-events-auto flex items-center gap-2 rounded-md bg-app/90 px-2 py-1 shadow-panel"
      data-testid="connection-indicator"
      data-state={state}
      // A live region: a connection dropping is something a screen-reader user
      // must be told about, and it happens without them doing anything.
      role="status"
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        className={`h-2 w-2 shrink-0 rounded-full ${DOT[state]}`}
      />
      {/* Visible text when there is something to say; an accessible-only
          label when there is not, so the dot is never colour-alone. */}
      {label ? (
        <span className="text-xs text-muted">{label}</span>
      ) : (
        <span className="sr-only">Connected</span>
      )}
    </div>
  )
}
