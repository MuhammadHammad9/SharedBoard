import { describe, expect, it } from 'vitest'
import { CLOSE_CODES } from '@coboard/shared'
import { backoffFor, reactionTo } from '../SocketClient.js'

/**
 * Reconnection policy — TRD §5.6, §10.2, R-SYNC-030.
 *
 * The two pure decisions are tested here on their own. Driving them through a
 * real socket would mean a fake `WebSocket`, a fake `fetch` for the ticket and
 * a fake clock, to assert two things that are ultimately arithmetic and a
 * switch — and the e2e suite exercises the wiring against a real server
 * anyway.
 */

describe('close-code reactions — TRD §5.6', () => {
  it('does not reconnect after a deliberate close', () => {
    expect(reactionTo(CLOSE_CODES.NORMAL)).toBe('stop')
    expect(reactionTo(CLOSE_CODES.GOING_AWAY)).toBe('stop')
  })

  it('retries a network drop', () => {
    // 1006 is the one that actually happens: wifi handover, sleep, a proxy
    // timing out. It has no meaning beyond "the connection ended badly".
    expect(reactionTo(CLOSE_CODES.ABNORMAL)).toBe('retry')
    expect(reactionTo(1011)).toBe('retry')
  })

  it('refreshes ONCE on 4001, then gives up', () => {
    // An expired access token is expected every fifteen minutes and must be
    // invisible. A second 4001 straight after a refresh means the session is
    // genuinely gone, and retrying would spin.
    expect(reactionTo(CLOSE_CODES.UNAUTHORIZED)).toBe('refresh-then-retry')
  })

  it('does NOT retry a decision', () => {
    // The server has made up its mind. Reconnecting into a 4003 is a loop
    // against an answer that will not change.
    expect(reactionTo(CLOSE_CODES.FORBIDDEN)).toBe('stop')
    expect(reactionTo(CLOSE_CODES.NOT_FOUND)).toBe('stop')
  })

  it('treats "too many connections" as retryable', () => {
    // 4029 is temporary by definition — the room was full a moment ago.
    expect(reactionTo(CLOSE_CODES.RATE_LIMITED)).toBe('retry')
  })
})

describe('full-jitter backoff — R-SYNC-030', () => {
  it('never exceeds the ceiling for the attempt', () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      const ceiling = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5))
      for (let i = 0; i < 50; i++) {
        const delay = backoffFor(attempt)
        expect(delay).toBeGreaterThanOrEqual(0)
        expect(delay).toBeLessThanOrEqual(ceiling)
      }
    }
  })

  it('SPREADS the delays rather than returning the ceiling', () => {
    /*
     * The whole point. `random() * ceiling`, not the ceiling itself: a server
     * that restarts with two hundred boards attached gets two hundred
     * reconnects spread across the window instead of two hundred arriving in
     * the same millisecond and killing it again.
     */
    const samples = Array.from({ length: 200 }, () => backoffFor(4))
    const unique = new Set(samples)
    expect(unique.size).toBeGreaterThan(150)

    const ceiling = 16_000
    // Roughly uniform: some well below half the ceiling, some well above.
    expect(samples.some(d => d < ceiling * 0.25)).toBe(true)
    expect(samples.some(d => d > ceiling * 0.75)).toBe(true)
  })

  it('caps the growth so a long outage does not mean an hour-long wait', () => {
    expect(backoffFor(50)).toBeLessThanOrEqual(30_000)
  })
})
