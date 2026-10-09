import type { ConnectionState } from '@coboard/shared'

/**
 * The connection state machine — FLOWS §15.2, FR-RT-009.
 *
 *   DISCONNECTED ─connect→ CONNECTING ─open→ SYNCING ─synced→ CONNECTED
 *                               │               │                 │
 *                               └──── drop ─────┴───── drop ──────┘
 *                                              ▼
 *                     ┌──────────────── RECONNECTING ◄── connect (retry now)
 *                     │ open → SYNCING        │ exhausted / browser offline
 *                     │                       ▼
 *                     └──────────────────── OFFLINE
 *
 * A table, not a tangle of `if`s in the socket client, because every state
 * maps to exactly one indicator in the header and the user reads it as the
 * truth. A transition the table does not list is REFUSED — a late `open`
 * from a socket we already gave up on must not flip a closed board to
 * "Syncing".
 *
 * `close` is the deliberate end — the board unmounted, or the server made a
 * decision (4003, 4004) — and is reachable from everywhere.
 */

export type ConnectionEvent =
  'connect' | 'open' | 'synced' | 'drop' | 'exhausted' | 'browser-offline' | 'close'

const TRANSITIONS: Record<
  ConnectionState,
  Partial<Record<ConnectionEvent, ConnectionState>>
> = {
  disconnected: { connect: 'connecting' },
  connecting: {
    open: 'syncing',
    drop: 'reconnecting',
    'browser-offline': 'offline',
    close: 'disconnected',
  },
  syncing: {
    synced: 'connected',
    drop: 'reconnecting',
    'browser-offline': 'offline',
    close: 'disconnected',
  },
  connected: {
    drop: 'reconnecting',
    'browser-offline': 'offline',
    close: 'disconnected',
  },
  reconnecting: {
    open: 'syncing',
    exhausted: 'offline',
    'browser-offline': 'offline',
    close: 'disconnected',
  },
  offline: {
    // "Retry now", the `online` event, or a tab coming back to the front.
    connect: 'reconnecting',
    open: 'syncing',
    close: 'disconnected',
  },
}

/** The next state, or null when the event is not allowed from `from`. */
export function transition(
  from: ConnectionState,
  event: ConnectionEvent,
): ConnectionState | null {
  return TRANSITIONS[from][event] ?? null
}
