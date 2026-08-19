import { describe, expect, it, vi } from 'vitest'
import { PRESENCE_COLOURS, type ServerMessage, type ServerOp } from '@coboard/shared'
import { RoomManager } from '../ws/RoomManager.js'
import type { Session } from '../ws/Session.js'

/**
 * Room bookkeeping — TRD §5.5.
 *
 * Pure unit tests against fake sessions. The socket suite proves the gateway
 * end to end; this proves the batching and colour rules on their own, where a
 * failure points at one function rather than at "something in the stack".
 */

let n = 0
function fakeSession(boardId = 'board-1'): Session & { sent: ServerMessage[] } {
  n += 1
  const sent: ServerMessage[] = []
  return {
    id: `session-${n}`,
    boardId,
    colour: PRESENCE_COLOURS[0]!,
    joined: true,
    open: true,
    sent,
    send: (message: ServerMessage) => void sent.push(message),
  } as unknown as Session & { sent: ServerMessage[] }
}

const op = (seq: number, actorSessionId: string): ServerOp =>
  ({
    id: `op-${seq}`,
    type: 'DELETE',
    objectId: `object-${seq}`,
    payload: {},
    seq,
    actorSessionId,
  }) as ServerOp

describe('colour assignment', () => {
  it('is round-robin over the frozen presence palette — R-UI-013', () => {
    const rooms = new RoomManager(0)
    const assigned = Array.from({ length: PRESENCE_COLOURS.length + 2 }, () => {
      const session = fakeSession()
      rooms.join(session)
      return session.colour
    })

    // Server-side, because a colour chosen on the client would differ between
    // participants, and the entire point is that everyone sees the same person
    // in the same colour.
    expect(assigned.slice(0, PRESENCE_COLOURS.length)).toEqual([...PRESENCE_COLOURS])
    expect(assigned[PRESENCE_COLOURS.length]).toBe(PRESENCE_COLOURS[0])
  })

  it('every colour is from the palette and nothing else', () => {
    const rooms = new RoomManager(0)
    for (let i = 0; i < 30; i++) {
      const session = fakeSession()
      rooms.join(session)
      expect(PRESENCE_COLOURS).toContain(session.colour)
    }
  })
})

describe('broadcast batching', () => {
  it('collapses ops from one window into a single message', () => {
    vi.useFakeTimers()
    const rooms = new RoomManager(16)
    const author = fakeSession()
    const other = fakeSession()
    rooms.join(author)
    rooms.join(other)

    rooms.queueOps('board-1', [op(1, author.id)], author.id)
    rooms.queueOps('board-1', [op(2, author.id)], author.id)
    rooms.queueOps('board-1', [op(3, author.id)], author.id)

    expect(other.sent).toHaveLength(0)
    vi.advanceTimersByTime(20)

    // Twenty people drawing produce twenty messages per frame; batched they
    // are one, and the window is short enough that nothing is delayed past a
    // paint the receiver was going to do anyway.
    expect(other.sent).toHaveLength(1)
    expect(other.sent[0]).toMatchObject({ t: 'op_batch' })
    expect((other.sent[0] as { ops: ServerOp[] }).ops.map(o => o.seq)).toEqual([1, 2, 3])
    vi.useRealTimers()
  })

  it('excludes each recipient PER OP, not per batch', () => {
    vi.useFakeTimers()
    const rooms = new RoomManager(16)
    const a = fakeSession()
    const b = fakeSession()
    rooms.join(a)
    rooms.join(b)

    // A and B both write inside one window.
    rooms.queueOps('board-1', [op(1, a.id)], a.id)
    rooms.queueOps('board-1', [op(2, b.id)], b.id)
    vi.advanceTimersByTime(20)

    /*
     * The bug this guards: excluding the whole batch from both authors means A
     * never receives B's op purely because they happened to write in the same
     * 16 ms. Everyone gets every op except their own.
     */
    expect((a.sent[0] as { ops: ServerOp[] }).ops.map(o => o.seq)).toEqual([2])
    expect((b.sent[0] as { ops: ServerOp[] }).ops.map(o => o.seq)).toEqual([1])
    vi.useRealTimers()
  })

  it('delivers ops in seq order even when queued out of order', () => {
    vi.useFakeTimers()
    const rooms = new RoomManager(16)
    const author = fakeSession()
    const other = fakeSession()
    rooms.join(author)
    rooms.join(other)

    rooms.queueOps('board-1', [op(3, author.id), op(1, author.id)], author.id)
    rooms.queueOps('board-1', [op(2, author.id)], author.id)
    vi.advanceTimersByTime(20)

    // The client drains contiguously and buffers gaps, so an out-of-order
    // batch would make it do work it does not need to do.
    expect((other.sent[0] as { ops: ServerOp[] }).ops.map(o => o.seq)).toEqual([1, 2, 3])
    vi.useRealTimers()
  })

  it('sends nothing to a room whose only member is the author', () => {
    vi.useFakeTimers()
    const rooms = new RoomManager(16)
    const author = fakeSession()
    rooms.join(author)

    rooms.queueOps('board-1', [op(1, author.id)], author.id)
    vi.advanceTimersByTime(20)

    expect(author.sent).toHaveLength(0)
    vi.useRealTimers()
  })
})

describe('membership', () => {
  it('drops an empty room rather than leaking it forever', () => {
    const rooms = new RoomManager(0)
    const session = fakeSession()
    rooms.join(session)
    expect(rooms.size('board-1')).toBe(1)

    rooms.leave(session)
    // A server up for a week accumulates one empty Map per board ever opened
    // if this is missed.
    expect(rooms.size('board-1')).toBe(0)
    expect(rooms.allSessions()).toEqual([])
  })

  it('reports a full room so the caller can close with 4029', () => {
    const rooms = new RoomManager(0)
    for (let i = 0; i < 50; i++) rooms.join(fakeSession())
    expect(rooms.isFull('board-1')).toBe(true)
  })

  it('keeps boards apart', () => {
    const rooms = new RoomManager(0)
    const a = fakeSession('board-a')
    const b = fakeSession('board-b')
    rooms.join(a)
    rooms.join(b)

    rooms.broadcast('board-a', { t: 'board_deleted' })
    expect(a.sent).toHaveLength(1)
    expect(b.sent).toHaveLength(0)
  })
})
