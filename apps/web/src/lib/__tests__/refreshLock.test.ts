/**
 * The silent refresh is serialized ACROSS TABS — R-SEC-006.
 *
 * Two tabs refreshing with the same cookie at once look like token theft to
 * the server, which revokes the family and signs both out. The Web Lock makes
 * the second tab wait and then present the cookie the first one received.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { attemptSilentRefresh, REFRESH_LOCK } from '../api.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('attemptSilentRefresh', () => {
  it('holds the cross-tab lock for the whole refresh request', async () => {
    const events: string[] = []
    vi.stubGlobal('navigator', {
      locks: {
        request: async (name: string, task: () => Promise<unknown>) => {
          events.push(`lock:${name}`)
          const result = await task()
          events.push('unlock')
          return result
        },
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        events.push('fetch')
        return new Response(JSON.stringify({ accessToken: 't' }), { status: 200 })
      }),
    )

    expect(await attemptSilentRefresh()).toBe(true)
    expect(events).toEqual([`lock:${REFRESH_LOCK}`, 'fetch', 'unlock'])
  })

  it('still refreshes where Web Locks do not exist', async () => {
    vi.stubGlobal('navigator', {})
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ accessToken: 't' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetch)
    expect(await attemptSilentRefresh()).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
