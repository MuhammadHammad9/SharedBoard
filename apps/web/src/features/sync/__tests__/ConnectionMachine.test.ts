import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_RECONNECT_ATTEMPTS, type ConnectionState } from '@coboard/shared'
import { transition } from '../ConnectionMachine.js'

/**
 * The connection state machine — FLOWS §15.2, FR-RT-009.
 *
 * The table is tested directly, and then the socket client is driven through
 * a real drop → retry → recover cycle against a fake socket and a manual
 * clock, because the table only matters if the client actually consults it.
 */

const api = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('../../../lib/api.js', () => ({ api }))

const { SocketClient } = await import('../SocketClient.js')

describe('the transition table', () => {
  it('walks the happy path', () => {
    expect(transition('disconnected', 'connect')).toBe('connecting')
    expect(transition('connecting', 'open')).toBe('syncing')
    expect(transition('syncing', 'synced')).toBe('connected')
  })

  it('drops to RECONNECTING and recovers through SYNCING, never straight to CONNECTED', () => {
    expect(transition('connected', 'drop')).toBe('reconnecting')
    expect(transition('reconnecting', 'open')).toBe('syncing')
    expect(transition('reconnecting', 'synced')).toBeNull()
  })

  it('goes OFFLINE when retries run out or the browser says so', () => {
    expect(transition('reconnecting', 'exhausted')).toBe('offline')
    for (const from of ['connecting', 'syncing', 'connected', 'reconnecting'] as const) {
      expect(transition(from, 'browser-offline')).toBe('offline')
    }
    expect(transition('offline', 'connect')).toBe('reconnecting')
  })

  it('refuses events that make no sense from a state', () => {
    // A late `open` after a deliberate close must not resurrect the header.
    expect(transition('disconnected', 'open')).toBeNull()
    expect(transition('connected', 'synced')).toBeNull()
    expect(transition('disconnected', 'drop')).toBeNull()
  })

  it('lets a deliberate close end every live state', () => {
    const live: ConnectionState[] = [
      'connecting',
      'syncing',
      'connected',
      'reconnecting',
      'offline',
    ]
    for (const from of live) expect(transition(from, 'close')).toBe('disconnected')
  })
})

/* ── The client, driven ────────────────────────────────────────────────────── */

class FakeSocket {
  static last: FakeSocket | null = null
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  constructor() {
    FakeSocket.last = this
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
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

/** A clock the test advances by hand. */
function manualTimers() {
  let now = 0
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = next++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer: (h: unknown) => void timers.delete(h as number),
    /** Fire every timer due within `ms`, in order. */
    advance(ms: number) {
      const until = now + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = until
    },
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('SocketClient through the machine', () => {
  let states: ConnectionState[]
  let attempts: number[]
  let clock: ReturnType<typeof manualTimers>

  const make = () =>
    new SocketClient(
      'board-1',
      {
        onOpen: () => {},
        onMessage: () => {},
        onState: s => states.push(s),
        onFatal: () => {},
        onAttempt: n => attempts.push(n),
      },
      {
        connect: () => new FakeSocket() as unknown as WebSocket,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      },
    )

  beforeEach(() => {
    states = []
    attempts = []
    clock = manualTimers()
    api.post.mockReset()
    api.post.mockResolvedValue({ ticket: 't' })
    vi.stubGlobal('navigator', { onLine: true })
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('stays SYNCING after open until told the outbox has drained', async () => {
    const client = make()
    await client.connect()
    FakeSocket.last!.open()
    expect(states).toEqual(['connecting', 'syncing'])
    client.markSynced()
    expect(states.at(-1)).toBe('connected')
  })

  it('reconnects after a drop, counting attempts, and comes back via SYNCING', async () => {
    const client = make()
    await client.connect()
    FakeSocket.last!.open()
    client.markSynced()

    FakeSocket.last!.drop()
    expect(states.at(-1)).toBe('reconnecting')
    expect(attempts).toEqual([1])

    clock.advance(1_000) // attempt 1 waits at most 1 s
    await flush()
    FakeSocket.last!.open()
    expect(states.at(-1)).toBe('syncing')
  })

  it(`goes OFFLINE after ${MAX_RECONNECT_ATTEMPTS} failed attempts, and "Retry now" starts over`, async () => {
    const client = make()
    await client.connect()
    FakeSocket.last!.open()
    client.markSynced()
    FakeSocket.last!.drop()

    for (let i = 0; i < MAX_RECONNECT_ATTEMPTS; i++) {
      clock.advance(30_000)
      await flush()
      FakeSocket.last!.drop()
    }
    expect(states.at(-1)).toBe('offline')
    expect(attempts.at(-1)).toBe(MAX_RECONNECT_ATTEMPTS)

    client.resume()
    expect(states.at(-1)).toBe('reconnecting')
    await flush()
    FakeSocket.last!.open()
    expect(states.at(-1)).toBe('syncing')
  })

  it('goes OFFLINE at once when the browser says so, and does not burn retries', async () => {
    const client = make()
    await client.connect()
    FakeSocket.last!.open()
    client.markSynced()

    vi.stubGlobal('navigator', { onLine: false })
    client.goOffline()
    expect(states.at(-1)).toBe('offline')

    FakeSocket.last!.drop()
    expect(states.at(-1)).toBe('offline')
    expect(attempts).toEqual([])
  })

  it('E-02: a tab returning to the front pings an open socket immediately', async () => {
    const client = make()
    await client.connect()
    FakeSocket.last!.open()
    client.markSynced()

    client.checkNow()
    expect(FakeSocket.last!.sent).toContain(JSON.stringify({ t: 'ping' }))
  })

  it('ignores a late open after a deliberate close', async () => {
    const client = make()
    await client.connect()
    const socket = FakeSocket.last!
    client.close()
    socket.onopen?.()
    expect(states.at(-1)).toBe('disconnected')
  })
})
