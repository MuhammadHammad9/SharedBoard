import { BACKOFF_BASE_MS, BACKOFF_MAX_MS } from '@coboard/shared'

/**
 * Reconnect and retry delay with FULL jitter — TRD §10.2, R-SYNC-030.
 *
 * Attempt 1 waits up to 1 s, then 2, 4, 8, 16, and 30 s from the sixth on:
 * a uniform random value in `[0, min(2^(n-1) · 1000, 30000)]`.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  `random() * ceiling`, never `ceiling ± a little`.                       │
 * │                                                                          │
 * │  A server that restarts with two hundred clients attached gets two       │
 * │  hundred reconnects spread across the window rather than two hundred     │
 * │  arriving in the same millisecond and knocking it over again. Partial    │
 * │  jitter still clusters them; only full jitter breaks the lockstep.       │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * One copy, used by both the socket and the outbox. Two copies had drifted to
 * two different curves, and only one of them matched the spec.
 */

export function backoffCeiling(attempt: number): number {
  const exponent = Math.min(Math.max(attempt, 1) - 1, 30)
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** exponent)
}

export function backoffFor(attempt: number, random: () => number = Math.random): number {
  return random() * backoffCeiling(attempt)
}
