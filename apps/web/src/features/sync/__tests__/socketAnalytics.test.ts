import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordedEvents } from '../../../lib/analytics.js'

/**
 * PRD §9 socket_disconnected / socket_reconnected, driven through a real
 * drop → failed retry → recovery against a fake socket and a manual clock.
 */

const api = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('../../../lib/api.js', () => ({ api }))

const { SocketClient, disconnectReason } = await import('../SocketClient.js')

class FakeSocket {
  static last: FakeSocket | null = null
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  constructor() {
    FakeSocket.last = this
  }
  send() {}
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

function manualClock() {
  let now = 0
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = next++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer: (h: unknown) => void timers.delete(h as number),
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

const socketEvents = (from: number) =>
  recordedEvents()
    .slice(from)
    .filter(e => e.event === 'socket_disconnected' || e.event === 'socket_reconnected')

describe('socket analytics — PRD §9', () => {
  let clock: ReturnType<typeof manualClock>
  let outbox: number

  const make = () =>
    new SocketClient(
      'board-1',
      {
        onOpen: () => {},
        onMessage: () => {},
        onState: () => {},
        onFatal: () => {},
        outboxSize: () => outbox,
      },
      {
        connect: () => new FakeSocket() as unknown as WebSocket,
        now: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
      },
    )

  beforeEach(() => {
    clock = manualClock()
    outbox = 0
    api.post.mockReset()
    api.post.mockResolvedValue({ ticket: 't' })
    vi.stubGlobal('navigator', { onLine: true })
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports the drop once, then the recovery with attempts, downtime and outbox size', async () => {
    const start = recordedEvents().length
    const client = make()
    await client.connect()
    FakeSocket.last!.open()
    client.markSynced()

    clock.advance(5_000)
    FakeSocket.last!.drop(1006)
    expect(socketEvents(start)).toEqual([
      expect.objectContaining({
        event: 'socket_disconnected',
        props: { reason: 'abnormal', session_duration_ms: 5_000 },
      }),
    ])

    // Attempt 1 never opens: not a second disconnect.
    clock.advance(30_000)
    await flush()
    FakeSocket.last!.drop(1006)
    expect(socketEvents(start)).toHaveLength(1)

    // Attempt 2 opens, with three changes waiting.
    outbox = 3
    const droppedAt = 5_000
    clock.advance(30_000)
    await flush()
    const openedAt = clock.now()
    FakeSocket.last!.open()

    const events = socketEvents(start)
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      event: 'socket_reconnected',
      props: { attempts: 2, downtime_ms: openedAt - droppedAt, outbox_size: 3 },
    })
  })

  it('does not report a deliberate close', async () => {
    const start = recordedEvents().length
    const client = make()
    await client.connect()
    FakeSocket.last!.open()
    client.close()
    expect(socketEvents(start)).toEqual([])
  })

  it('maps close codes to short reasons', () => {
    expect(disconnectReason(1006)).toBe('abnormal')
    expect(disconnectReason(4003)).toBe('forbidden')
    expect(disconnectReason(1011)).toBe('code_1011')
  })
})
