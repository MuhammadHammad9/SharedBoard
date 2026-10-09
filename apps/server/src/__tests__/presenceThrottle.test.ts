import { describe, expect, it } from 'vitest'
import { PRESENCE_THROTTLE_MS } from '@coboard/shared'
import { PRESENCE_BUCKET, Session } from '../ws/Session.js'

/**
 * The per-session presence budget — finding 11. Pure: a fake socket and an
 * injected clock, so the timing is exact rather than scheduler-dependent.
 */

const fakeSocket = { readyState: 1, send: () => {}, close: () => {} } as never
const session = () =>
  new Session(fakeSocket, 'board', { kind: 'user', userId: 'u1' }, 'Priya', 'EDITOR')

describe('presence token bucket', () => {
  it('never drops a legitimate client: cursor, stroke, xform and sel each at 20 Hz for a minute', () => {
    const s = session()
    const start = Date.now()
    let dropped = 0
    // Four streams, each sending every PRESENCE_THROTTLE_MS, slightly jittered
    // in the sender's favour (messages arriving early, in bunches).
    for (let t = 0; t < 60_000; t += PRESENCE_THROTTLE_MS) {
      for (let stream = 0; stream < 4; stream++) {
        if (!s.takePresenceToken(start + t + (stream % 2))) dropped += 1
      }
    }
    expect(dropped).toBe(0)
  })

  it('absorbs a burst from a stalled tab, up to the capacity', () => {
    const s = session()
    const now = Date.now()
    let allowed = 0
    for (let i = 0; i < PRESENCE_BUCKET.capacity; i++) {
      if (s.takePresenceToken(now)) allowed += 1
    }
    expect(allowed).toBe(PRESENCE_BUCKET.capacity)
  })

  it('drops a flood beyond the budget, then recovers at the refill rate', () => {
    const s = session()
    const now = Date.now()
    let allowed = 0
    for (let i = 0; i < 5_000; i++) if (s.takePresenceToken(now)) allowed += 1
    expect(allowed).toBe(PRESENCE_BUCKET.capacity)
    // One second later, one second's worth is back.
    let after = 0
    for (let i = 0; i < 5_000; i++) if (s.takePresenceToken(now + 1_000)) after += 1
    expect(after).toBe(PRESENCE_BUCKET.rate)
  })
})
