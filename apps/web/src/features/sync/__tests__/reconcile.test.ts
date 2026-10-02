import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BoardObject,
  ClientOp,
  ObjectId,
  ServerMessage,
  ServerOp,
} from '@coboard/shared'
import { boardStore } from '../../../stores/boardStore.js'
import { history } from '../../canvas/history/history.js'
import { applyAndEmit, createOps, deleteOps } from '../../canvas/history/apply.js'
import { updateOp } from '../../canvas/history/inverseOps.js'
import { applyRemoteOp } from '../../canvas/history/applyRemote.js'
import {
  createSocketTransport,
  startPersistence,
  stopPersistence,
  type PersistenceSession,
  type SocketTransportBinding,
} from '../persistence.js'

/**
 * Where the local document meets the server's verdict — F-1, F-2, F-3, F-7 in
 * docs/REMAINING-WORK.md.
 *
 * Driven through the real outbox and the real socket transport, with only the
 * wire faked: the claims here are about what the board shows after an ack or
 * a nack, and a mocked outbox would prove nothing about that.
 */

/*
 * Restored ops flush the moment persistence starts — before any socket is
 * bound — so they go over REST. That is the real order (session.ts), so the
 * REST call is what those tests answer.
 */
const appendOps = vi.hoisted(() => vi.fn())
vi.mock('../../boards/api.js', () => ({ appendOps, getOpsSince: vi.fn() }))

const OBJ = '00000000-0000-4000-8000-000000000001' as ObjectId

const sticky = (extra: Partial<Record<string, unknown>> = {}): BoardObject =>
  ({
    id: OBJ,
    type: 'sticky',
    x: 0,
    y: 0,
    width: 200,
    height: 200,
    rotation: 0,
    zIndex: 'a0',
    opacity: 1,
    createdBy: 'test',
    createdAt: 1,
    updatedAt: 1,
    text: 'note',
    color: '#FEF08A',
    fontSize: 16,
    textAlign: 'left',
    ...extra,
  }) as BoardObject

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

let storage: Map<string, string>
let wire: ClientOp[][]
let binding: SocketTransportBinding
let session: PersistenceSession
const onNack = vi.fn()

function start(loadSeq = 0): void {
  session = startPersistence('board-1', {
    loadSeq,
    onNack,
    discardHistory: ids => history.discard(ids),
  })
  binding = createSocketTransport(
    message => {
      wire.push(message.ops)
      return true
    },
    () => true,
  )
  session.bindSocket(binding)
}

const settle = async (message: ServerMessage) => {
  binding.settle(message)
  await tick()
}
const ack = (ops: ClientOp[], seqs: number[]) =>
  settle({ t: 'ack', ids: ops.map(o => o.id), seqs })
const nack = (op: ClientOp) =>
  settle({ t: 'nack', id: op.id, code: 'INVALID_OP', message: 'no' })

const remote = (op: ClientOp, seq: number): ServerOp =>
  ({ ...op, seq, actorSessionId: 'someone-else' }) as unknown as ServerOp
/** The SyncEngine's path for a remote batch, minus ordering. */
const receive = (ops: ServerOp[]) =>
  applyRemoteOp(session.reconcileRemote(ops) as unknown as ClientOp[])

/** The sticky under test, read as a plain record — the fields vary by type. */
const current = () =>
  boardStore.getState().objects.get(OBJ) as Record<string, unknown> | undefined

beforeEach(() => {
  storage = new Map()
  wire = []
  appendOps.mockReset()
  // Unanswered by default: only the restored-op tests reach REST at all.
  appendOps.mockImplementation(() => new Promise(() => {}))
  onNack.mockReset()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  })
  vi.stubGlobal('navigator', { onLine: true })
  boardStore.getState().loadObjects([])
  history.clear()
})

afterEach(() => {
  stopPersistence()
  vi.unstubAllGlobals()
})

describe('a nack puts the board back — CLAUDE.md §3.2 6b, R-SYNC-011', () => {
  it('removes a refused create, drops its undo entry, and reports it once', async () => {
    start()
    applyAndEmit(createOps([sticky()]), 'Draw')
    await tick()
    expect(current()).toBeDefined()
    expect(history.canUndo()).toBe(true)

    await nack(wire[0]![0]!)

    expect(current()).toBeUndefined()
    expect(history.canUndo()).toBe(false)
    expect(onNack).toHaveBeenCalledTimes(1)
    // Never retried.
    expect(wire).toHaveLength(1)
  })

  it('restores the confirmed value of a refused update', async () => {
    boardStore.getState().loadObjects([sticky({ color: '#FEF08A' })])
    start()
    applyAndEmit([updateOp(OBJ, { color: '#BFDBFE' })], 'Colour')
    await tick()
    expect(current()?.color).toBe('#BFDBFE')

    await nack(wire[0]![0]!)
    expect(current()?.color).toBe('#FEF08A')
    expect(history.canUndo()).toBe(false)
  })

  it('brings back an object whose refused delete was the only change', async () => {
    boardStore.getState().loadObjects([sticky()])
    start()
    applyAndEmit(deleteOps([OBJ]), 'Delete')
    await tick()
    expect(current()).toBeUndefined()

    await nack(wire[0]![0]!)
    expect(current()?.text).toBe('note')
  })
})

describe('held fields — R-CONV-001', () => {
  it('holds a remote write to a field I am waiting on, and releases it on ack', async () => {
    boardStore.getState().loadObjects([sticky()])
    start()
    applyAndEmit([updateOp(OBJ, { color: '#BFDBFE' })], 'Colour')
    await tick()

    // Ordered BEFORE mine (seq 5); mine will be 6. Mine is the true value.
    receive([remote(updateOp(OBJ, { color: '#FECACA', x: 40 }), 5)])
    expect(current()?.color).toBe('#BFDBFE')
    // The fields I was not touching still arrive.
    expect(current()?.x).toBe(40)

    await ack(wire[0]!, [6])
    // Released: a later remote write is shown.
    receive([remote(updateOp(OBJ, { color: '#E9D5FF' }), 7)])
    expect(current()?.color).toBe('#E9D5FF')
  })

  it('treats my own op echoed in a catch-up as an ack, and does not apply it twice', async () => {
    boardStore.getState().loadObjects([sticky()])
    start()
    applyAndEmit([updateOp(OBJ, { color: '#BFDBFE' })], 'Colour')
    await tick()
    const mine = wire[0]![0]!

    /*
     * The socket dropped before the ack arrived. The rejoin replays seq 6
     * (mine) and seq 7 (theirs, same field). Theirs is later and wins — and
     * it is only shown because the echo of mine released the field first.
     */
    receive([remote(mine, 6), remote(updateOp(OBJ, { color: '#FECACA' }), 7)])
    expect(current()?.color).toBe('#FECACA')
  })
})

describe('a confirmed delete tombstones at its real seq — F-2', () => {
  it("lets a teammate's later re-create through", async () => {
    boardStore.getState().loadObjects([sticky()])
    start()
    applyAndEmit(deleteOps([OBJ]), 'Delete')
    await tick()
    await ack(wire[0]!, [10])

    // A teammate's undo, ordered after my delete.
    receive([
      remote(
        { id: 'r1', type: 'CREATE', objectId: OBJ, payload: sticky() } as ClientOp,
        11,
      ),
    ])
    expect(current()).toBeDefined()
  })

  it('still refuses a concurrent update ordered before the delete', async () => {
    boardStore.getState().loadObjects([sticky()])
    start()
    applyAndEmit(deleteOps([OBJ]), 'Delete')
    await tick()
    await ack(wire[0]!, [10])
    receive([remote(updateOp(OBJ, { x: 99 }), 9)])
    expect(current()).toBeUndefined()
  })
})

describe('ops restored after a reload are shown — F-7', () => {
  const persist = (ops: ClientOp[]) =>
    storage.set('coboard.outbox.board-1', JSON.stringify({ v: 1, at: 1, ops }))

  it('applies restored work to the freshly loaded document', () => {
    boardStore.getState().loadObjects([sticky({ color: '#FEF08A' })])
    persist([updateOp(OBJ, { color: '#BBF7D0' })])
    start(20)
    expect(current()?.color).toBe('#BBF7D0')
  })

  const storedAt = (op: ClientOp, seq: number, duplicate: boolean) =>
    appendOps.mockResolvedValueOnce({ applied: [{ id: op.id, seq, duplicate }] })

  it('reverts a restored op the snapshot already contained, so later edits win', async () => {
    // The snapshot (seq 20) shows a teammate's colour, written after mine.
    boardStore.getState().loadObjects([sticky({ color: '#FECACA' })])
    const mine = updateOp(OBJ, { color: '#BBF7D0' })
    persist([mine])
    // The server already had mine, at seq 12.
    storedAt(mine, 12, true)
    start(20)
    await tick()
    expect(current()?.color).toBe('#FECACA')
  })

  it('keeps a restored op the server stores for the first time', async () => {
    boardStore.getState().loadObjects([sticky({ color: '#FEF08A' })])
    const mine = updateOp(OBJ, { color: '#BBF7D0' })
    persist([mine])
    storedAt(mine, 21, false)
    start(20)
    await tick()
    expect(current()?.color).toBe('#BBF7D0')
  })

  it('does not replay a restored create over the object the snapshot already has', () => {
    boardStore.getState().loadObjects([sticky({ text: 'edited since' })])
    persist([{ id: 'c1', type: 'CREATE', objectId: OBJ, payload: sticky() } as ClientOp])
    start(20)
    expect(current()?.text).toBe('edited since')
  })
})
