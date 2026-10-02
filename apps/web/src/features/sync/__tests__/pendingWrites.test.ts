import { describe, expect, it } from 'vitest'
import type { ClientOp } from '@coboard/shared'
import { PendingWrites } from '../pendingWrites.js'

/**
 * Held fields — R-CONV-001, R-CONV-006.
 *
 * The unit tests pin the bookkeeping. The simulation at the bottom is the one
 * that matters: two clients, a server that orders, random interleavings, and
 * an assertion that everyone ends on the same document. Before this module
 * existed, the simulation diverged within a handful of seeds.
 */

let n = 0
const update = (objectId: string, payload: Record<string, unknown>): ClientOp => ({
  id: `op-${++n}`,
  type: 'UPDATE',
  objectId,
  payload,
})
const inverseOf = (op: ClientOp, before: Record<string, unknown>): ClientOp[] => [
  {
    id: `inv-${op.id}`,
    type: 'UPDATE',
    objectId: op.objectId,
    payload: Object.fromEntries(Object.keys(op.payload).map(k => [k, before[k]])),
  },
]

describe('PendingWrites', () => {
  it('holds a field with a pending local write and passes the rest', () => {
    const p = new PendingWrites()
    const mine = update('a', { fill: 'red' })
    p.track([mine], inverseOf(mine, { fill: 'white' }))

    const remote = update('a', { fill: 'blue', x: 5 })
    expect(p.filterRemote(remote)?.payload).toEqual({ x: 5 })
    expect(p.filterRemote(update('b', { fill: 'blue' }))?.payload).toEqual({
      fill: 'blue',
    })
  })

  it('drops a remote update entirely when every field is held', () => {
    const p = new PendingWrites()
    const mine = update('a', { fill: 'red' })
    p.track([mine], inverseOf(mine, { fill: 'white' }))
    expect(p.filterRemote(update('a', { fill: 'blue' }))).toBeNull()
  })

  it('never holds back a delete — delete wins', () => {
    const p = new PendingWrites()
    const mine = update('a', { fill: 'red' })
    p.track([mine], inverseOf(mine, { fill: 'white' }))
    const del: ClientOp = { id: 'd', type: 'DELETE', objectId: 'a', payload: {} }
    expect(p.filterRemote(del)).toBe(del)
  })

  it('releases a field when its last pending write is acked', () => {
    const p = new PendingWrites()
    const one = update('a', { fill: 'red' })
    const two = update('a', { fill: 'green' })
    p.track([one], inverseOf(one, { fill: 'white' }))
    p.track([two], inverseOf(two, { fill: 'red' }))

    p.ack(one.id)
    expect(p.filterRemote(update('a', { fill: 'blue' }))).toBeNull()
    p.ack(two.id)
    expect(p.filterRemote(update('a', { fill: 'blue' }))?.payload).toEqual({
      fill: 'blue',
    })
    expect(p.size).toBe(0)
  })

  it('reverts a refused update to the confirmed value', () => {
    const p = new PendingWrites()
    const mine = update('a', { fill: 'red' })
    p.track([mine], inverseOf(mine, { fill: 'white' }))
    expect(p.revert(mine.id)).toEqual([
      expect.objectContaining({
        type: 'UPDATE',
        objectId: 'a',
        payload: { fill: 'white' },
      }),
    ])
  })

  it('reverts to the newest REMOTE value it held back, not the stale base', () => {
    const p = new PendingWrites()
    const mine = update('a', { fill: 'red' })
    p.track([mine], inverseOf(mine, { fill: 'white' }))
    p.filterRemote(update('a', { fill: 'blue' }))
    expect(p.revert(mine.id)[0]?.payload).toEqual({ fill: 'blue' })
  })

  it('does not revert a field a later pending write still holds', () => {
    const p = new PendingWrites()
    const one = update('a', { fill: 'red' })
    const two = update('a', { fill: 'green' })
    p.track([one], inverseOf(one, { fill: 'white' }))
    p.track([two], inverseOf(two, { fill: 'red' }))
    // The server will end with `green`, so `red` refused changes nothing.
    expect(p.revert(one.id)).toEqual([])
  })

  it('reverts a refused create with a delete that leaves no lasting tombstone', () => {
    const p = new PendingWrites()
    const create = {
      id: 'c',
      type: 'CREATE',
      objectId: 'a',
      payload: { id: 'a' },
    } as unknown as ClientOp
    p.track([create], null)
    expect(p.revert('c')).toEqual([
      expect.objectContaining({ type: 'DELETE', objectId: 'a', seq: 0 }),
    ])
  })

  it('reverts a refused delete by recreating the object from its inverse', () => {
    const p = new PendingWrites()
    const del: ClientOp = { id: 'd', type: 'DELETE', objectId: 'a', payload: {} }
    const recreate = {
      id: 'r',
      type: 'CREATE',
      objectId: 'a',
      payload: { id: 'a' },
    } as unknown as ClientOp
    p.track([del], [recreate])
    expect(p.revert('d')).toEqual([
      expect.objectContaining({ type: 'CREATE', objectId: 'a' }),
    ])
  })

  it('pairs each op with its own inverse in a multi-op batch', () => {
    const p = new PendingWrites()
    const a = update('a', { x: 1 })
    const b = update('b', { x: 2 })
    // buildInverse returns inverses reversed: [inv(b), inv(a)].
    p.track([a, b], [...inverseOf(b, { x: 20 }), ...inverseOf(a, { x: 10 })])
    expect(p.revert(a.id)[0]?.payload).toEqual({ x: 10 })
    expect(p.revert(b.id)[0]?.payload).toEqual({ x: 20 })
  })
})

/* ── The convergence simulation ─────────────────────────────────────────────── */

type Doc = Map<string, Record<string, unknown>>

/** mulberry32 — a seeded PRNG, so a failing seed can be replayed. */
function rng(seed: number): () => number {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const applyTo = (doc: Doc, op: ClientOp): void => {
  const obj = doc.get(op.objectId)
  if (op.type === 'UPDATE' && obj) doc.set(op.objectId, { ...obj, ...op.payload })
}

interface Client {
  doc: Doc
  pending: PendingWrites
  /** Sent to the server, awaiting their turn. */
  wire: ClientOp[]
  /** Broadcasts the server has not flushed yet — its 16 ms batch. */
  batched: Array<{ op: ClientOp; seq: number }>
  /** Server → client messages, delivered in order. */
  inbox: Array<
    { kind: 'ack'; id: string; seq: number } | { kind: 'op'; op: ClientOp; seq: number }
  >
  /** The SyncEngine's ordering state. */
  lastApplied: number
  remote: Map<number, ClientOp>
  own: Map<number, string>
}

/**
 * The real protocol, in miniature: the server orders, acks the author AT
 * ONCE and batches broadcasts (TRD §5.4 steps 6–7), and each client applies
 * in seq order with its own ops as markers — SyncEngine.drain.
 *
 * `releaseAtAck` models the first, wrong version of the hold: fields released
 * the moment the ack arrived rather than when the document reached its seq.
 */
function simulate(seed: number, releaseAtAck = false): { a: Doc; b: Doc; server: Doc } {
  const random = rng(seed)
  const seedDoc = (): Doc =>
    new Map([
      ['o1', { fill: 'w', x: 0 }],
      ['o2', { fill: 'w', x: 0 }],
    ])
  const server = seedDoc()
  let seq = 0
  const clients: Client[] = [0, 1].map(() => ({
    doc: seedDoc(),
    pending: new PendingWrites(),
    wire: [],
    batched: [],
    inbox: [],
    lastApplied: 0,
    remote: new Map(),
    own: new Map(),
  }))

  const drain = (c: Client) => {
    for (;;) {
      const next = c.lastApplied + 1
      const op = c.remote.get(next)
      if (op) {
        c.remote.delete(next)
        const kept = c.pending.filterRemote(op)
        if (kept) applyTo(c.doc, kept)
        c.lastApplied = next
        continue
      }
      const mine = c.own.get(next)
      if (mine !== undefined) {
        c.own.delete(next)
        if (!releaseAtAck) c.pending.ack(mine)
        c.lastApplied = next
        continue
      }
      return
    }
  }

  const step = (allowEdits: boolean) => {
    const c = clients[Math.floor(random() * 2)]!
    const other = clients.find(x => x !== c)!
    const roll = allowEdits ? random() : 0.35 + random() * 0.65
    if (roll < 0.35) {
      // A local edit, applied optimistically.
      const objectId = random() < 0.5 ? 'o1' : 'o2'
      const field = random() < 0.5 ? 'fill' : 'x'
      const op = update(objectId, { [field]: Math.floor(random() * 100) })
      const before = c.doc.get(objectId)!
      c.pending.track([op], inverseOf(op, before))
      applyTo(c.doc, op)
      c.wire.push(op)
    } else if (roll < 0.6 && c.wire.length > 0) {
      // The server orders the next op from this client. Ack now; broadcast
      // whenever the batch timer fires.
      const op = c.wire.shift()!
      seq += 1
      applyTo(server, op)
      c.inbox.push({ kind: 'ack', id: op.id, seq })
      other.batched.push({ op, seq })
    } else if (roll < 0.75 && c.batched.length > 0) {
      // The 16 ms batch fires.
      for (const b of c.batched.splice(0)) c.inbox.push({ kind: 'op', ...b })
    } else if (c.inbox.length > 0) {
      const message = c.inbox.shift()!
      if (message.kind === 'ack') {
        if (releaseAtAck) c.pending.ack(message.id)
        c.own.set(message.seq, message.id)
      } else {
        c.remote.set(message.seq, message.op)
      }
      drain(c)
    }
  }

  for (let i = 0; i < 200; i++) step(true)
  // Drain with no new edits: everything sent is ordered, everything ordered
  // is delivered.
  for (let guard = 0; guard < 10_000; guard++) {
    if (
      clients.every(
        c => c.wire.length === 0 && c.inbox.length === 0 && c.batched.length === 0,
      )
    )
      break
    step(false)
  }
  return { a: clients[0]!.doc, b: clients[1]!.doc, server }
}

const converged = ({ a, b, server }: { a: Doc; b: Doc; server: Doc }) =>
  JSON.stringify([...a]) === JSON.stringify([...server]) &&
  JSON.stringify([...b]) === JSON.stringify([...server])

describe('two clients and a server converge under random interleavings', () => {
  for (let seed = 1; seed <= 200; seed++) {
    it(`seed ${seed}`, () => {
      const { a, b, server } = simulate(seed)
      expect(Object.fromEntries(a)).toEqual(Object.fromEntries(server))
      expect(Object.fromEntries(b)).toEqual(Object.fromEntries(server))
    })
  }

  it('would NOT converge if held fields were released at the ack', () => {
    /*
     * Kept as a test so the reason for releasing in seq order cannot quietly
     * regress: with acks immediate and broadcasts batched, an ack routinely
     * overtakes an earlier remote write to the same field.
     */
    let diverged = 0
    for (let seed = 1; seed <= 200; seed++)
      if (!converged(simulate(seed, true))) diverged++
    expect(diverged).toBeGreaterThan(10)
  })
})
