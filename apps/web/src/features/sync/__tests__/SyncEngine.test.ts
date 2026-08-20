import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardObject, ServerOp } from '@coboard/shared'
import { boardStore } from '../../../stores/boardStore.js'
import { SyncEngine } from '../SyncEngine.js'

/**
 * Ordering, gaps and the load rule — TRD §6.2, §6.3, FLOWS §2.3 STEP 5.
 *
 * Three properties have to hold for the board to converge, and TRD §6.2 says
 * you must be able to explain them in a review: the fold is **commutative**
 * for disjoint objects, **idempotent**, and **convergent**. Each has a test.
 */

let n = 0
function sticky(id?: string): BoardObject {
  n += 1
  return {
    id: id ?? `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    type: 'sticky',
    x: 0,
    y: 0,
    width: 200,
    height: 200,
    rotation: 0,
    zIndex: `a${String(n).padStart(6, '0')}`,
    opacity: 1,
    createdBy: 'test',
    createdAt: 1,
    updatedAt: 1,
    text: 'note',
    color: '#FEF08A',
    fontSize: 16,
    textAlign: 'left',
  } as BoardObject
}

const op = (seq: number, partial: Partial<ServerOp> & Pick<ServerOp, 'type' | 'objectId'>): ServerOp =>
  ({
    id: `op-${seq}`,
    payload: {},
    actorSessionId: 'them',
    seq,
    ...partial,
  }) as ServerOp

const createOp = (seq: number, object: BoardObject): ServerOp =>
  op(seq, { type: 'CREATE', objectId: object.id, payload: object })

const updateOp = (seq: number, id: string, payload: Record<string, unknown>): ServerOp =>
  op(seq, { type: 'UPDATE', objectId: id, payload })

const deleteOp = (seq: number, id: string): ServerOp =>
  op(seq, { type: 'DELETE', objectId: id, payload: {} })

const noop = () => {}
const callbacks = {
  onState: noop,
  onRole: noop,
  onNack: noop,
  onFatal: noop,
}

function engine() {
  return new SyncEngine('board-1', callbacks, {
    send: () => true,
    markSynced: noop,
    // Immediate timers, so the debounced gap fill does not make the suite wait.
    setTimer: fn => {
      queueMicrotask(fn)
      return 1
    },
    clearTimer: noop,
    fetchOpsSince: () => Promise.resolve({ ops: [], currentSeq: 0 }),
  })
}

const ids = () => [...boardStore.getState().objects.keys()]

beforeEach(() => {
  n = 0
  boardStore.getState().loadObjects([])
})

/* ── The load-ordering rule — R-SYNC-035 ──────────────────────────────────── */

describe('the load rule', () => {
  it('BUFFERS ops that arrive before the snapshot', () => {
    const sync = engine()
    const a = sticky()

    sync.receiveOps([createOp(1, a)])
    // Nothing applied yet. Applying now and then loading the snapshot would
    // overwrite it — the "flickers in and disappears" bug.
    expect(ids()).toEqual([])

    sync.snapshotReady(0)
    expect(ids()).toEqual([a.id])
  })

  it('DROPS buffered ops the snapshot already contains', () => {
    const sync = engine()
    const a = sticky()
    const b = sticky()

    sync.receiveOps([createOp(1, a), createOp(2, b)])
    // The snapshot is current as of seq 2, so both were already in it.
    boardStore.getState().loadObjects([a, b])
    sync.snapshotReady(2)

    expect(ids().sort()).toEqual([a.id, b.id].sort())
    expect(sync.appliedSeq).toBe(2)
  })

  it('replays only what the snapshot missed', () => {
    const sync = engine()
    const a = sticky()
    const b = sticky()

    sync.receiveOps([createOp(1, a), createOp(2, b)])
    boardStore.getState().loadObjects([a])
    sync.snapshotReady(1)

    expect(ids().sort()).toEqual([a.id, b.id].sort())
  })
})

/* ── Ordering — TRD §6.3 ──────────────────────────────────────────────────── */

describe('ordered application', () => {
  it('buffers a gap and drains contiguously once it is filled', () => {
    const sync = engine()
    sync.snapshotReady(0)
    const a = sticky()
    const b = sticky()
    const c = sticky()

    // 1 arrives, then 3 — 2 is missing.
    sync.receiveOps([createOp(1, a)])
    sync.receiveOps([createOp(3, c)])

    expect(ids()).toEqual([a.id])
    expect(sync.pendingCount).toBe(1)

    // Filling the hole must release everything waiting behind it in ONE pass,
    // not just the op that filled it.
    sync.receiveOps([createOp(2, b)])
    expect(ids().sort()).toEqual([a.id, b.id, c.id].sort())
    expect(sync.appliedSeq).toBe(3)
    expect(sync.pendingCount).toBe(0)
  })

  it('never applies an UPDATE before the CREATE it depends on', () => {
    const sync = engine()
    sync.snapshotReady(0)
    const a = sticky()

    sync.receiveOps([updateOp(2, a.id, { x: 500 })])
    // Applying out of order would drop this update against an object that
    // does not exist yet, and the move would be lost forever.
    expect(ids()).toEqual([])

    sync.receiveOps([createOp(1, a)])
    expect(boardStore.getState().objects.get(a.id as never)?.x).toBe(500)
  })

  it('is IDEMPOTENT: re-delivering an applied op changes nothing', () => {
    const sync = engine()
    sync.snapshotReady(0)
    const a = sticky()

    sync.receiveOps([createOp(1, a)])
    sync.receiveOps([updateOp(2, a.id, { x: 42 })])
    sync.receiveOps([createOp(1, a), updateOp(2, a.id, { x: 42 })])

    // Re-delivery after a reconnect is normal and must be free.
    expect(ids()).toEqual([a.id])
    expect(boardStore.getState().objects.get(a.id as never)?.x).toBe(42)
    expect(sync.appliedSeq).toBe(2)
  })

  it('is COMMUTATIVE for disjoint objects', () => {
    const a = sticky()
    const b = sticky()

    const forward = engine()
    forward.snapshotReady(0)
    forward.receiveOps([createOp(1, a), createOp(2, b)])
    const first = ids().sort()

    boardStore.getState().loadObjects([])
    const reversed = engine()
    reversed.snapshotReady(0)
    // Delivered in the opposite order; the seq ordering restores the truth.
    reversed.receiveOps([createOp(2, b)])
    reversed.receiveOps([createOp(1, a)])

    expect(ids().sort()).toEqual(first)
  })
})

/* ── Conflict resolution — FLOWS §9.3, R-CONV-002/004 ─────────────────────── */

describe('the concurrent edit matrix', () => {
  it('AT-03: a move and a recolour on the same object BOTH survive', () => {
    const sync = engine()
    sync.snapshotReady(0)
    const a = sticky()
    sync.receiveOps([createOp(1, a)])

    sync.receiveOps([updateOp(2, a.id, { x: 400 })])
    sync.receiveOps([updateOp(3, a.id, { color: '#BFDBFE' })])

    // R-CONV-002: partial payloads merge field-wise. Sending whole objects
    // would make this a lost update, which is the entire reason for the rule.
    const object = boardStore.getState().objects.get(a.id as never)
    expect(object).toMatchObject({ x: 400, color: '#BFDBFE' })
  })

  it('AT-05: two writes to the same field converge on the later seq', () => {
    const sync = engine()
    sync.snapshotReady(0)
    const a = sticky()
    sync.receiveOps([createOp(1, a)])

    sync.receiveOps([updateOp(3, a.id, { color: '#BBF7D0' })])
    sync.receiveOps([updateOp(2, a.id, { color: '#FECACA' })])

    // Both clients see the seq-3 value, whatever order the ops arrived in.
    expect(boardStore.getState().objects.get(a.id as never)).toMatchObject({
      color: '#BBF7D0',
    })
  })

  it('AT-04: delete beats a concurrent update, with no zombie', () => {
    const sync = engine()
    sync.snapshotReady(0)
    const a = sticky()
    sync.receiveOps([createOp(1, a)])

    sync.receiveOps([deleteOp(2, a.id)])
    sync.receiveOps([updateOp(3, a.id, { x: 900 })])

    expect(ids()).toEqual([])
  })

  it('a create that lost to a delete stays lost, whatever order it ARRIVES in', () => {
    const sync = engine()
    sync.snapshotReady(0)
    const a = sticky()

    /*
     * The delete is at seq 3, the create at seq 2 — the create lost. Delivered
     * newest-first, which is what a reordered batch looks like on a bad
     * connection.
     *
     * The drain re-orders them by seq before applying, so the create runs
     * first and the delete second, and the object ends gone. Applying in
     * ARRIVAL order would leave a zombie that every other client has deleted.
     */
    sync.receiveOps([deleteOp(3, a.id)])
    expect(sync.pendingCount).toBe(1)

    sync.receiveOps([createOp(1, sticky()), createOp(2, a)])
    expect(ids()).toHaveLength(1)
    expect(boardStore.getState().objects.has(a.id as never)).toBe(false)
  })

  it('but a LATER create — an undo — does bring it back (D-13)', () => {
    const sync = engine()
    sync.snapshotReady(0)
    const a = sticky()

    sync.receiveOps([createOp(1, a)])
    sync.receiveOps([deleteOp(2, a.id)])
    expect(ids()).toEqual([])

    // Someone pressed Ctrl+Z. Undo emits an ordinary CREATE at a higher seq.
    sync.receiveOps([createOp(3, a)])
    // A bare Set-of-tombstones would drop this, and the object would return
    // for the person who undid and for nobody else.
    expect(ids()).toEqual([a.id])
  })

  it('deleting twice is a no-op, not an error', () => {
    const sync = engine()
    sync.snapshotReady(0)
    const a = sticky()
    sync.receiveOps([createOp(1, a)])
    sync.receiveOps([deleteOp(2, a.id)])
    sync.receiveOps([deleteOp(3, a.id)])
    expect(ids()).toEqual([])
  })
})

/* ── Gap fill — TRD §6.3 ──────────────────────────────────────────────────── */

describe('gap fill', () => {
  it('asks the server for the missing ops and applies them', async () => {
    const a = sticky()
    const b = sticky()
    const fetchOpsSince = vi.fn(() =>
      Promise.resolve({ ops: [createOp(2, b)] as never[], currentSeq: 3 }),
    )

    const sync = new SyncEngine('board-1', callbacks, {
      send: () => true,
      markSynced: noop,
      setTimer: fn => {
        queueMicrotask(fn)
        return 1
      },
      clearTimer: noop,
      fetchOpsSince,
    })
    sync.snapshotReady(0)

    sync.receiveOps([createOp(1, a)])
    sync.receiveOps([createOp(3, sticky())])
    await new Promise(r => setTimeout(r, 5))

    expect(fetchOpsSince).toHaveBeenCalledWith('board-1', 1)
    expect(sync.appliedSeq).toBe(3)
  })

  it('does not ask when there is no gap', async () => {
    const fetchOpsSince = vi.fn(() => Promise.resolve({ ops: [], currentSeq: 1 }))
    const sync = new SyncEngine('board-1', callbacks, {
      send: () => true,
      markSynced: noop,
      setTimer: fn => {
        queueMicrotask(fn)
        return 1
      },
      clearTimer: noop,
      fetchOpsSince,
    })
    sync.snapshotReady(0)

    sync.receiveOps([createOp(1, sticky())])
    await new Promise(r => setTimeout(r, 5))

    // Out-of-order delivery inside one batch is common and self-healing;
    // asking on every reordered pair would be a request per frame.
    expect(fetchOpsSince).not.toHaveBeenCalled()
  })
})

/* ── Server messages ──────────────────────────────────────────────────────── */

describe('server messages', () => {
  it('reports a nack so the board can roll back', () => {
    const onNack = vi.fn()
    const sync = new SyncEngine(
      'board-1',
      { ...callbacks, onNack },
      { send: () => true, markSynced: noop },
    )
    sync.handle({ t: 'nack', id: 'op-9', code: 'FORBIDDEN', message: 'View-only' })
    expect(onNack).toHaveBeenCalledWith(['op-9'], 'FORBIDDEN')
  })

  it('surfaces a deleted board and a revoked role as fatal', () => {
    const onFatal = vi.fn()
    const sync = new SyncEngine(
      'board-1',
      { ...callbacks, onFatal },
      { send: () => true, markSynced: noop },
    )
    sync.handle({ t: 'board_deleted' })
    sync.handle({ t: 'access_revoked' })
    expect(onFatal.mock.calls).toEqual([['deleted'], ['forbidden']])
  })

  it('re-joins with the applied seq, not from zero', () => {
    const send = vi.fn(() => true)
    const sync = new SyncEngine('board-1', callbacks, { send, markSynced: noop })
    sync.snapshotReady(0)
    sync.receiveOps([createOp(1, sticky()), createOp(2, sticky())])

    sync.join()
    // A reconnect asks for the gap, not for the whole board.
    expect(send).toHaveBeenCalledWith({ t: 'join', boardId: 'board-1', sinceSeq: 2 })
  })
})
