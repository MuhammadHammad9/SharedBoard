import { describe, expect, it } from 'vitest'
import { CLOSE_CODES } from '@coboard/shared'
import { reactionTo } from '../SocketClient.js'

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

// The backoff curve itself is tested in backoff.test.ts.
