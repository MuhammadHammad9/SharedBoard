import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientOp } from '@coboard/shared'
import { clearOutbox, Outbox, OUTBOX_MAX, type OutboxTransport } from '../Outbox.js'

/**
 * The outbox — FR-SYNC-004/005, R-SYNC-010/011/014/030.
 *
 * These are the tests that decide whether "you never lose work" is true, so
 * they are written against the real persistence layer rather than a mock of
 * it: a fake `localStorage` that always succeeds would prove nothing about the
 * restore path, which is the whole point.
 */

/** A `localStorage` good enough to be the real thing for these tests. */
function installStorage(): Map<string, string> {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  return store
}

let store: Map<string, string>
let ids = 0
const op = (type: ClientOp['type'] = 'DELETE'): ClientOp =>
  ({
    id: `op-${++ids}`,
    type,
    objectId: `obj-${ids}`,
    payload: {},
  }) as ClientOp

/** Timers are injected, so backoff never makes the suite wait. */
const immediate = {
  setTimer: (fn: () => void) => {
    queueMicrotask(fn)
    return 1
  },
  clearTimer: () => {},
}

const ackAll: OutboxTransport = ops =>
  Promise.resolve({ acked: ops.map(o => o.id), nacked: [] })

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  store = installStorage()
  vi.stubGlobal('navigator', { onLine: true })
  ids = 0
})

describe('sending', () => {
  it('sends queued ops and empties the queue on ack', async () => {
    const send = vi.fn(ackAll)
    const outbox = new Outbox({ boardId: 'b1', send, ...immediate })

    outbox.enqueue([op(), op()])
    await settle()

    expect(send).toHaveBeenCalledOnce()
    expect(outbox.pending).toBe(0)
  })

  it('batches one call per enqueue, not one per op — R-SYNC-017', async () => {
    const send = vi.fn(ackAll)
    const outbox = new Outbox({ boardId: 'b1', send, ...immediate })

    // A ten-object drag is ONE action and must be one request.
    outbox.enqueue([op(), op(), op(), op(), op(), op(), op(), op(), op(), op()])
    await settle()

    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0]![0]).toHaveLength(10)
  })

  it('does not send while offline, and flushes on resume', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    const send = vi.fn(ackAll)
    const outbox = new Outbox({ boardId: 'b1', send, ...immediate })

    outbox.enqueue([op()])
    await settle()
    expect(send).not.toHaveBeenCalled()
    // The op is not lost — it is queued, which is the entire point.
    expect(outbox.pending).toBe(1)

    vi.stubGlobal('navigator', { onLine: true })
    outbox.resume()
    await settle()

    expect(send).toHaveBeenCalledOnce()
    expect(outbox.pending).toBe(0)
  })

  it('does not run two flushes at once over the same queue', async () => {
    let resolveFirst: (v: { acked: string[]; nacked: string[] }) => void = () => {}
    const send = vi.fn(
      (_ops: readonly ClientOp[]) =>
        new Promise<{ acked: string[]; nacked: string[] }>(resolve => {
          resolveFirst = resolve
        }),
    )
    const outbox = new Outbox({ boardId: 'b1', send, ...immediate })

    const a = op()
    outbox.enqueue([a])
    // A second enqueue while the first request is in flight must not start a
    // second walker, or the same batch goes out twice.
    outbox.enqueue([op()])
    await settle()
    expect(send).toHaveBeenCalledOnce()

    resolveFirst({ acked: [a.id], nacked: [] })
    await settle()
    expect(send).toHaveBeenCalledTimes(2)
  })
})

describe('failures', () => {
  it('retries a transport failure and keeps the ops queued — R-SYNC-030', async () => {
    let attempt = 0
    const send = vi.fn(async (ops: readonly ClientOp[]) => {
      attempt += 1
      if (attempt === 1) throw new Error('network down')
      return { acked: ops.map(o => o.id), nacked: [] }
    })
    const outbox = new Outbox({ boardId: 'b1', send, ...immediate })

    outbox.enqueue([op()])
    await settle()
    await settle()

    expect(send).toHaveBeenCalledTimes(2)
    expect(outbox.pending).toBe(0)
  })

  it('does NOT retry a nack, and reports it — R-SYNC-011', async () => {
    const refused = op()
    const send = vi.fn(async () => ({ acked: [], nacked: [refused.id] }))
    const onNack = vi.fn()
    const outbox = new Outbox({ boardId: 'b1', send, onNack, ...immediate })

    outbox.enqueue([refused])
    await settle()
    await settle()

    // A nack is a DECISION. Retrying it would loop forever against a server
    // that has already made up its mind.
    expect(send).toHaveBeenCalledOnce()
    expect(outbox.pending).toBe(0)
    expect(onNack).toHaveBeenCalledWith([refused])
  })

  it('keeps ops enqueued DURING a request rather than splicing them away', async () => {
    let resolveSend: (v: { acked: string[]; nacked: string[] }) => void = () => {}
    const send = vi.fn(
      (_ops: readonly ClientOp[]) =>
        new Promise<{ acked: string[]; nacked: string[] }>(r => {
          resolveSend = r
        }),
    )
    const outbox = new Outbox({ boardId: 'b1', send, ...immediate })

    const first = op()
    outbox.enqueue([first])
    await settle()

    const during = op()
    outbox.enqueue([during])

    resolveSend({ acked: [first.id], nacked: [] })
    await settle()

    // Removing "the first N" instead of "these ids" would have discarded an op
    // that was never sent — a silent loss, and the hardest kind to find.
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]![0]).toEqual([during])
  })
})

describe('persistence across a reload', () => {
  it('restores unacked ops and sends them on the next session', async () => {
    const never: OutboxTransport = () => Promise.reject(new Error('offline'))
    const first = new Outbox({
      boardId: 'b1',
      send: never,
      setTimer: () => 1,
      clearTimer: () => {},
    })
    const pending = op()
    first.enqueue([pending])
    await settle()
    first.close()

    // A new tab, a new Outbox, the same board.
    const send = vi.fn(ackAll)
    const second = new Outbox({ boardId: 'b1', send, ...immediate })
    expect(second.snapshot()).toEqual([pending])

    second.resume()
    await settle()
    expect(send).toHaveBeenCalledWith([pending])
  })

  it('clears the stored queue once everything is acked', async () => {
    const outbox = new Outbox({ boardId: 'b1', send: ackAll, ...immediate })
    outbox.enqueue([op()])
    await settle()
    // Leaving an empty array behind would make every board carry a stale key.
    expect(store.has('coboard.outbox.b1')).toBe(false)
  })

  it('keeps boards separate', async () => {
    const a = new Outbox({
      boardId: 'a',
      send: () => Promise.reject(new Error('x')),
      setTimer: () => 1,
      clearTimer: () => {},
    })
    a.enqueue([op()])
    await settle()

    const b = new Outbox({ boardId: 'b', send: ackAll, ...immediate })
    expect(b.snapshot()).toEqual([])
  })

  it('discards a hand-edited queue instead of replaying junk forever', async () => {
    store.set(
      'coboard.outbox.b1',
      JSON.stringify({ v: 1, ops: [{ nonsense: true }, 'a string', null] }),
    )
    const outbox = new Outbox({ boardId: 'b1', send: ackAll, ...immediate })
    // localStorage is user-writable. An op that can never pass the server's
    // Zod schema would otherwise be retried on every load, forever.
    expect(outbox.snapshot()).toEqual([])
  })

  it('ignores a queue written by a different version', async () => {
    store.set('coboard.outbox.b1', JSON.stringify({ v: 99, ops: [op()] }))
    expect(new Outbox({ boardId: 'b1', send: ackAll, ...immediate }).snapshot()).toEqual(
      [],
    )
  })

  it('survives storage being unavailable', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: () => {},
    })
    const send = vi.fn(ackAll)
    const outbox = new Outbox({ boardId: 'b1', send, ...immediate })

    // Private mode must not break drawing. This session loses nothing; only
    // survival across a reload is given up.
    outbox.enqueue([op()])
    await settle()
    expect(send).toHaveBeenCalledOnce()
  })

  it('trims from the FRONT past the cap, keeping the most recent work', async () => {
    const outbox = new Outbox({
      boardId: 'b1',
      send: () => Promise.reject(new Error('offline')),
      setTimer: () => 1,
      clearTimer: () => {},
    })
    const many = Array.from({ length: OUTBOX_MAX + 10 }, () => op())
    outbox.enqueue(many)

    expect(outbox.pending).toBe(OUTBOX_MAX)
    // Refusing new ops instead would break drawing while offline, which is the
    // one thing the offline path exists to protect.
    expect(outbox.snapshot().at(-1)).toEqual(many.at(-1))
  })

  it('clearOutbox removes a board queue', () => {
    store.set('coboard.outbox.b1', JSON.stringify({ v: 1, ops: [op()] }))
    clearOutbox('b1')
    expect(store.has('coboard.outbox.b1')).toBe(false)
  })
})
