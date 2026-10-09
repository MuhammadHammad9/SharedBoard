import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionState } from '@coboard/shared'

/**
 * Two resume triggers at once — `online` and `visibilitychange` both fire when
 * a laptop wakes. The connect guard has to cover the async ticket fetch, and a
 * superseded socket's late events must not tear down the live one.
 */

const api = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('../../../lib/api.js', () => ({ api }))

const { SocketClient } = await import('../SocketClient.js')

class FakeSocket {
  static all: FakeSocket[] = []
  readyState = 0
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  constructor() {
    FakeSocket.all.push(this)
  }
  send() {}
  close() {
    this.readyState = 3
    this.closed = true
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  drop(code = 1006) {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('SocketClient — concurrent connects', () => {
  let states: ConnectionState[]
  let opens: number

  const make = () =>
    new SocketClient(
      'board-1',
      {
        onOpen: () => {
          opens += 1
        },
        onMessage: () => {},
        onState: s => states.push(s),
        onFatal: () => {},
      },
      {
        connect: () => new FakeSocket() as unknown as WebSocket,
        // Timers never fire on their own here: nothing in these cases should
        // depend on a retry.
        setTimer: () => 0,
        clearTimer: () => {},
      },
    )

  beforeEach(() => {
    FakeSocket.all = []
    states = []
    opens = 0
    api.post.mockReset()
    api.post.mockResolvedValue({ ticket: 't' })
    vi.stubGlobal('navigator', { onLine: true })
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens ONE socket when two resumes race across the ticket fetch', async () => {
    const client = make()
    // online + visibilitychange, same tick.
    client.resume()
    client.resume()
    await flush()
    expect(api.post).toHaveBeenCalledTimes(1)
    expect(FakeSocket.all).toHaveLength(1)
  })

  it("ignores a superseded socket's late close, keeping the live one", async () => {
    const timers: Array<{ fn: () => void; ms: number } | null> = []
    const client = new SocketClient(
      'board-1',
      {
        onOpen: () => {},
        onMessage: () => {},
        onState: s => states.push(s),
        onFatal: () => {},
      },
      {
        connect: () => new FakeSocket() as unknown as WebSocket,
        setTimer: (fn, ms) => timers.push({ fn, ms }) - 1,
        clearTimer: h => {
          timers[h as number] = null
        },
      },
    )
    const fire = (ms: number) => {
      const index = timers.findIndex(t => t?.ms === ms)
      const timer = timers[index]!
      timers[index] = null
      timer.fn()
    }

    await client.connect()
    const first = FakeSocket.all[0]!
    first.open()
    client.markSynced()

    // Heartbeat: ping, then no pong. The client tears the socket down itself
    // and reconnects — the dead socket's own `close` has not arrived yet.
    fire(25_000)
    fire(10_000)
    // The retry timer (backoff) reconnects.
    const retry = timers.findIndex(t => t !== null && t.ms !== 25_000 && t.ms !== 10_000)
    timers[retry]!.fn()
    timers[retry] = null
    await flush()
    const second = FakeSocket.all[1]!
    second.open()
    client.markSynced()
    expect(client.connectionState).toBe('connected')
    const before = states.length

    // Now the first socket's close finally lands.
    first.drop(1006)

    expect(client.isOpen).toBe(true)
    expect(client.connectionState).toBe('connected')
    expect(states.slice(before)).toEqual([])
    // Its heartbeat is still scheduled.
    expect(timers.some(t => t?.ms === 25_000)).toBe(true)
  })

  it('a restart during an in-flight ticket fetch does not open two sockets', async () => {
    let release: (v: { ticket: string }) => void = () => {}
    api.post.mockImplementationOnce(
      () => new Promise<{ ticket: string }>(r => (release = r)),
    )
    const client = make()
    void client.connect()
    client.restart()
    await flush()
    // The stale ticket arrives after the restart's own connect.
    release({ ticket: 'stale' })
    await flush()
    expect(FakeSocket.all).toHaveLength(1)
    FakeSocket.all[0]!.open()
    expect(opens).toBe(1)
  })
})
