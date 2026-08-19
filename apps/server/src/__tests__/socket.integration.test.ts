import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import WebSocket from 'ws'
import {
  CLOSE_CODES,
  NACK_CODES,
  type BoardObject,
  type ClientOp,
  type ServerMessage,
} from '@coboard/shared'
import { createApp } from '../http/app.js'
import { attachGateway, type Gateway } from '../ws/gateway.js'
import { Fanout } from '../ws/fanout.js'
import { RoomManager } from '../ws/RoomManager.js'
import { prisma } from '../lib/prisma.js'
import { closeRedis, redis, waitForRedis } from '../lib/redis.js'

/**
 * The WebSocket gateway — TRD §5.1, §5.4, §5.6.
 *
 * A REAL server on a real port, driven by a real `ws` client, against a real
 * Postgres and Redis. Everything below is about behaviour that only exists
 * once those parts are wired together: the upgrade rejecting an unauthorized
 * peer before allocating anything, the ack arriving before the broadcast, the
 * sequence staying gap-free when a hundred writes race over the socket rather
 * than over HTTP.
 *
 * TRD §16 calls this phase the one where the project either succeeds or turns
 * into a swamp. This file is the drain.
 */

let server: Server
let gateway: Gateway
let port: number
let app: ReturnType<typeof createApp>

const password = 'correct-horse-1'
let counter = 0
const freshEmail = () => `sock${++counter}.${Date.now()}@example.com`

interface Actor {
  token: string
  userId: string
}

async function signUp(displayName = 'Priya Raman'): Promise<Actor> {
  const email = freshEmail()
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password, displayName })
  expect(response.status).toBe(201)
  const user = await prisma.user.findUniqueOrThrow({
    where: { emailLower: email.toLowerCase() },
  })
  return { token: response.body.accessToken as string, userId: user.id }
}

async function createBoard(actor: Actor): Promise<string> {
  const response = await request(app)
    .post('/api/boards')
    .set({ Authorization: `Bearer ${actor.token}` })
    .send({ name: 'Q3 Retrospective' })
  expect(response.status).toBe(201)
  return response.body.board.id as string
}

async function getTicket(actor: Actor, boardId: string): Promise<string> {
  const response = await request(app)
    .post('/api/ws/ticket')
    .set({ Authorization: `Bearer ${actor.token}` })
    .send({ boardId })
  expect(response.status).toBe(200)
  return response.body.ticket as string
}

/**
 * A test client that records every message.
 *
 * `waitFor` polls rather than registering a one-shot listener, because the
 * message being waited for may already have arrived — an ack can beat the
 * assertion that wants it, and a listener registered afterwards waits forever.
 */
class Client {
  readonly received: ServerMessage[] = []
  private constructor(readonly socket: WebSocket) {}

  static async connect(ticket: string): Promise<Client> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket}`)
    const client = new Client(socket)
    socket.on('message', data => {
      client.received.push(JSON.parse(String(data)) as ServerMessage)
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    return client
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message))
  }

  async waitFor<T extends ServerMessage['t']>(
    t: T,
    timeoutMs = 4_000,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = this.received.find(m => m.t === t)
      if (found) return found as Extract<ServerMessage, { t: T }>
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for "${t}"; saw [${this.received.map(m => m.t).join(', ')}]`,
        )
      }
      await new Promise(r => setTimeout(r, 10))
    }
  }

  all<T extends ServerMessage['t']>(t: T): Array<Extract<ServerMessage, { t: T }>> {
    return this.received.filter(m => m.t === t) as Array<Extract<ServerMessage, { t: T }>>
  }

  async join(boardId: string, sinceSeq = 0) {
    this.send({ t: 'join', boardId, sinceSeq })
    return this.waitFor('join_ack')
  }

  close(): void {
    this.socket.close()
  }
}

const clients: Client[] = []
async function connect(actor: Actor, boardId: string): Promise<Client> {
  const client = await Client.connect(await getTicket(actor, boardId))
  clients.push(client)
  return client
}

let objectSeed = 0
function sticky(): BoardObject {
  objectSeed += 1
  return {
    id: randomUUID(),
    type: 'sticky',
    x: objectSeed * 10,
    y: 0,
    width: 200,
    height: 200,
    rotation: 0,
    zIndex: `a${objectSeed.toString(36).padStart(6, '0')}`,
    opacity: 1,
    createdBy: 'test',
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_000_000,
    text: 'What slowed us down?',
    color: '#FEF08A',
    fontSize: 16,
    textAlign: 'left',
  } as BoardObject
}

const createOp = (object: BoardObject): ClientOp => ({
  id: randomUUID(),
  type: 'CREATE',
  objectId: object.id,
  payload: object,
})

beforeAll(async () => {
  app = createApp()
  await waitForRedis()

  server = createServer(app)
  // A zero-length batch window: these tests assert what is delivered, not when,
  // and waiting 16 ms per assertion adds seconds across the file for nothing.
  gateway = attachGateway(server, { rooms: new RoomManager(0) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})

beforeEach(async () => {
  await prisma.user.deleteMany({})
  const keys = await redis().keys('rl:*')
  if (keys.length > 0) await redis().del(...keys)
})

afterEach(() => {
  for (const client of clients.splice(0)) client.close()
})

afterAll(async () => {
  await gateway.close()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await prisma.user.deleteMany({})
  await prisma.$disconnect()
  await closeRedis()
})

/* ── POST /api/ws/ticket — TRD §5.1 ───────────────────────────────────────── */

describe('the ticket endpoint', () => {
  it('issues a ticket with a short TTL', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)

    const response = await request(app)
      .post('/api/ws/ticket')
      .set({ Authorization: `Bearer ${priya.token}` })
      .send({ boardId })

    expect(response.status).toBe(200)
    expect(response.body.ticket).toMatch(/^[0-9a-f]{64}$/)
    // 60 seconds is what makes a ticket in an access log worthless. It exists
    // because the browser WebSocket constructor cannot set an Authorization
    // header, and a 15-minute bearer token in a query string is a credential
    // leak with a schedule.
    expect(response.body.expiresIn).toBe(60)
  })

  it('refuses an anonymous caller', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const response = await request(app).post('/api/ws/ticket').send({ boardId })
    expect(response.status).toBe(401)
  })

  it('refuses a malformed board id rather than issuing a useless ticket', async () => {
    const priya = await signUp()
    const response = await request(app)
      .post('/api/ws/ticket')
      .set({ Authorization: `Bearer ${priya.token}` })
      .send({ boardId: 'not-a-uuid' })
    expect(response.status).toBe(422)
  })

  it('grants a VIEWER a ticket — they may watch, just not write', async () => {
    const priya = await signUp()
    const marcus = await signUp('Marcus Feld')
    const boardId = await createBoard(priya)
    await prisma.boardMember.create({
      data: { boardId, userId: marcus.userId, role: 'VIEWER' },
    })

    const response = await request(app)
      .post('/api/ws/ticket')
      .set({ Authorization: `Bearer ${marcus.token}` })
      .send({ boardId })
    expect(response.status).toBe(200)
  })
})

/* ── The handshake — TRD §5.1 ─────────────────────────────────────────────── */

describe('the upgrade', () => {
  it('refuses a connection with no ticket, before allocating anything', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const error = await new Promise<Error>(resolve => socket.once('error', resolve))
    // A plain HTTP 401: the upgrade never completed, so there is no WebSocket
    // to close with a code. Rejecting here costs one comparison; accepting and
    // waiting for an auth message would hold a socket for an anonymous peer.
    expect(error.message).toContain('401')
  })

  it('refuses a forged ticket', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${'0'.repeat(64)}`)
    const error = await new Promise<Error>(resolve => socket.once('error', resolve))
    expect(error.message).toContain('401')
  })

  it('refuses a request to a path that is not /ws', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/socket`)
    const error = await new Promise<Error>(resolve => socket.once('error', resolve))
    expect(error.message).toContain('404')
  })

  it('a ticket is SINGLE USE', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const ticket = await getTicket(priya, boardId)

    const first = await Client.connect(ticket)
    clients.push(first)

    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket}`)
    const error = await new Promise<Error>(resolve => socket.once('error', resolve))
    // Redeemed with GETDEL, so a ticket captured from a log or a Referer is
    // worthless the moment it has been used once.
    expect(error.message).toContain('401')
  })

  it('refuses a ticket for a board the caller cannot read', async () => {
    const priya = await signUp()
    const marcus = await signUp('Marcus Feld')
    const boardId = await createBoard(marcus)

    const response = await request(app)
      .post('/api/ws/ticket')
      .set({ Authorization: `Bearer ${priya.token}` })
      .send({ boardId })

    // 404, not 403 — R-SEC-018. Authorization is answered over HTTP where a
    // refusal can carry a real error envelope.
    expect(response.status).toBe(404)
  })

  it('re-resolves the role at upgrade rather than trusting the ticket', async () => {
    const priya = await signUp()
    const marcus = await signUp('Marcus Feld')
    const boardId = await createBoard(priya)
    const membership = await prisma.boardMember.create({
      data: { boardId, userId: marcus.userId, role: 'EDITOR' },
    })

    const ticket = await getTicket(marcus, boardId)
    // Demoted after the ticket was issued, before it was redeemed. A stale
    // role baked into the ticket would let the old one stand for 60 seconds.
    await prisma.boardMember.update({
      where: { id: membership.id },
      data: { role: 'VIEWER' },
    })

    const client = await Client.connect(ticket)
    clients.push(client)
    const ack = await client.join(boardId)
    expect(ack.role).toBe('VIEWER')
  })
})

/* ── join — TRD §5.1, FLOWS §2.3 STEP 5 ───────────────────────────────────── */

describe('join', () => {
  it('acks with the current seq, the role, a session id and a colour', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const client = await connect(priya, boardId)

    const ack = await client.join(boardId)
    expect(ack.seq).toBe(0)
    expect(ack.role).toBe('OWNER')
    expect(ack.sessionId).toEqual(expect.any(String))
    // The frozen 12-colour presence palette, assigned server-side — R-UI-013.
    expect(ack.colour).toMatch(/^#[0-9A-F]{6}$/i)
    expect(ack.users).toEqual([])
  })

  it('lists the people already in the room, and tells them someone arrived', async () => {
    const priya = await signUp()
    const marcus = await signUp('Marcus Feld')
    const boardId = await createBoard(priya)
    await prisma.boardMember.create({
      data: { boardId, userId: marcus.userId, role: 'EDITOR' },
    })

    const a = await connect(priya, boardId)
    await a.join(boardId)

    const b = await connect(marcus, boardId)
    const ack = await b.join(boardId)

    expect(ack.users.map(u => u.name)).toEqual(['Priya Raman'])
    const joined = await a.waitFor('presence_join')
    expect(joined.user.name).toBe('Marcus Feld')
  })

  it('replays only the ops after sinceSeq — the reconnect path', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)

    const a = await connect(priya, boardId)
    await a.join(boardId)
    a.send({ t: 'op_batch', ops: [createOp(sticky()), createOp(sticky())] })
    await a.waitFor('ack')

    const b = await connect(priya, boardId)
    const ack = await b.join(boardId, 1)
    expect(ack.seq).toBe(2)

    const batch = await b.waitFor('op_batch')
    expect(batch.ops.map(op => op.seq)).toEqual([2])
  })

  it('refuses a join for a board the ticket was not issued for', async () => {
    const priya = await signUp()
    const boardA = await createBoard(priya)
    const boardB = await createBoard(priya)

    const client = await connect(priya, boardA)
    const closed = new Promise<number>(resolve =>
      client.socket.once('close', code => resolve(code)),
    )
    client.send({ t: 'join', boardId: boardB, sinceSeq: 0 })

    // Otherwise a ticket for a board you CAN read becomes a join to any board
    // you name, and the authorization was done against the wrong resource.
    expect(await closed).toBe(CLOSE_CODES.FORBIDDEN)
  })

  it('ignores ops from a socket that has not joined', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const client = await connect(priya, boardId)

    client.send({ t: 'op', op: createOp(sticky()) })
    await new Promise(r => setTimeout(r, 200))

    expect(client.received).toEqual([])
    expect(await prisma.operation.count({ where: { boardId } })).toBe(0)
  })
})

/* ── handleOp, the seven steps — TRD §5.4 ─────────────────────────────────── */

describe('ops over the socket', () => {
  it('acks the author with the assigned seq and broadcasts to everyone else', async () => {
    const priya = await signUp()
    const marcus = await signUp('Marcus Feld')
    const boardId = await createBoard(priya)
    await prisma.boardMember.create({
      data: { boardId, userId: marcus.userId, role: 'EDITOR' },
    })

    const a = await connect(priya, boardId)
    const b = await connect(marcus, boardId)
    await a.join(boardId)
    await b.join(boardId)

    const op = createOp(sticky())
    a.send({ t: 'op', op })

    const ack = await a.waitFor('ack')
    expect(ack).toMatchObject({ ids: [op.id], seqs: [1] })

    const batch = await b.waitFor('op_batch')
    expect(batch.ops[0]).toMatchObject({ id: op.id, seq: 1 })
    expect(batch.ops[0]!.actorSessionId).toEqual(expect.any(String))
  })

  it('does NOT echo an op back to its author', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const a = await connect(priya, boardId)
    await a.join(boardId)

    a.send({ t: 'op', op: createOp(sticky()) })
    await a.waitFor('ack')
    await new Promise(r => setTimeout(r, 150))

    // Harmless if it happened — the client drops ops at or below its applied
    // seq — but it doubles the traffic and every trace with it.
    expect(a.all('op_batch')).toHaveLength(0)
  })

  it('STEP 1: nacks a VIEWER and writes nothing — AT-20 over the socket', async () => {
    const priya = await signUp()
    const marcus = await signUp('Marcus Feld')
    const boardId = await createBoard(priya)
    await prisma.boardMember.create({
      data: { boardId, userId: marcus.userId, role: 'VIEWER' },
    })

    const viewer = await connect(marcus, boardId)
    await viewer.join(boardId)

    const op = createOp(sticky())
    viewer.send({ t: 'op', op })

    const nack = await viewer.waitFor('nack')
    expect(nack).toMatchObject({ id: op.id, code: NACK_CODES.FORBIDDEN })
    // Authorization runs first, so the forged op costs one comparison and
    // leaves no trace at all.
    expect(await prisma.operation.count({ where: { boardId } })).toBe(0)
    expect(await prisma.board.findUniqueOrThrow({ where: { id: boardId } })).toMatchObject(
      { currentSeq: 0 },
    )
  })

  it('STEP 2: nacks a malformed op and stays up', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const a = await connect(priya, boardId)
    await a.join(boardId)

    const id = randomUUID()
    a.send({
      t: 'op',
      op: { id, type: 'CREATE', objectId: randomUUID(), payload: { nonsense: true } },
    })

    const nack = await a.waitFor('nack')
    expect(nack).toMatchObject({ id, code: NACK_CODES.INVALID_OP })

    // Still serving. A malformed frame must not take the gateway down with it.
    const good = createOp(sticky())
    a.send({ t: 'op', op: good })
    expect((await a.waitFor('ack')).ids).toContain(good.id)
  })

  it('nacks only the BAD op in a mixed batch, and stores the rest', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const a = await connect(priya, boardId)
    await a.join(boardId)

    const good = createOp(sticky())
    a.send({
      t: 'op_batch',
      ops: [
        good,
        { id: randomUUID(), type: 'CREATE', objectId: randomUUID(), payload: {} },
      ],
    })

    await a.waitFor('nack')
    const ack = await a.waitFor('ack')
    // One bad op in a paste of forty must not discard the thirty-nine that
    // were fine.
    expect(ack.ids).toEqual([good.id])
  })

  it('survives a frame that is not JSON at all', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const a = await connect(priya, boardId)
    await a.join(boardId)

    a.socket.send('}{ not json')
    await new Promise(r => setTimeout(r, 100))

    const op = createOp(sticky())
    a.send({ t: 'op', op })
    expect((await a.waitFor('ack')).ids).toContain(op.id)
  })

  it('STEP 4: a replayed op id is re-acked with its ORIGINAL seq', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const a = await connect(priya, boardId)
    await a.join(boardId)

    const op = createOp(sticky())
    a.send({ t: 'op', op })
    expect((await a.waitFor('ack')).seqs).toEqual([1])

    a.send({ t: 'op', op })
    await new Promise(r => setTimeout(r, 200))

    // R-SYNC-014: the reconnect replay. Both acks carry seq 1, and there is
    // one row — inserting again would duplicate the object on every screen.
    const acks = a.all('ack')
    expect(acks).toHaveLength(2)
    expect(acks[1]!.seqs).toEqual([1])
    expect(await prisma.operation.count({ where: { boardId } })).toBe(1)
  })

  it('does not re-broadcast a duplicate to the room', async () => {
    const priya = await signUp()
    const marcus = await signUp('Marcus Feld')
    const boardId = await createBoard(priya)
    await prisma.boardMember.create({
      data: { boardId, userId: marcus.userId, role: 'EDITOR' },
    })

    const a = await connect(priya, boardId)
    const b = await connect(marcus, boardId)
    await a.join(boardId)
    await b.join(boardId)

    const op = createOp(sticky())
    a.send({ t: 'op', op })
    await b.waitFor('op_batch')

    a.send({ t: 'op', op })
    await new Promise(r => setTimeout(r, 200))

    // A flaky connection replaying its backlog must not re-broadcast it to
    // everyone on every attempt.
    expect(b.all('op_batch')).toHaveLength(1)
  })

  it('nacks an op for a board that has been trashed', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const a = await connect(priya, boardId)
    await a.join(boardId)

    await prisma.board.update({ where: { id: boardId }, data: { deletedAt: new Date() } })
    a.send({ t: 'op', op: createOp(sticky()) })

    expect((await a.waitFor('nack')).code).toBe(NACK_CODES.BOARD_GONE)
  })

  it('answers a ping with a pong', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const a = await connect(priya, boardId)
    await a.join(boardId)

    a.send({ t: 'ping' })
    await a.waitFor('pong')
  })
})

/* ── The one that matters — R-SYNC-013 over the wire ──────────────────────── */

describe('sequence assignment under concurrency, over the socket', () => {
  it('100 concurrent op writes produce a monotonic gap-free sequence', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)

    /*
     * Five sockets, twenty ops each, all in flight at once.
     *
     * Phase 8 proved this for the REST path. It is worth proving again here
     * because the socket path is genuinely different: five independent
     * connections, no HTTP request serialisation, and `handleOps` is async all
     * the way down. If the block-allocated `UPDATE ... RETURNING` were ever
     * replaced with a read-then-write, this is where it would show.
     */
    const sockets = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const client = await connect(priya, boardId)
        await client.join(boardId)
        return client
      }),
    )

    await Promise.all(
      sockets.map(async client => {
        for (let i = 0; i < 20; i++) client.send({ t: 'op', op: createOp(sticky()) })
        await expectSeqCount(client, 20)
      }),
    )

    const rows = await prisma.operation.findMany({
      where: { boardId },
      orderBy: { seq: 'asc' },
      select: { seq: true },
    })

    expect(rows).toHaveLength(100)
    // Gap-free and duplicate-free: seq n sits at index n-1, with no exceptions.
    expect(rows.map(r => r.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1))
    expect(await prisma.board.findUniqueOrThrow({ where: { id: boardId } })).toMatchObject(
      { currentSeq: 100, objectCount: 100 },
    )
  })
})

/** Wait until a client has been acked for `n` ops in total. */
async function expectSeqCount(client: Client, n: number, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const acked = client.all('ack').reduce((sum, a) => sum + a.ids.length, 0)
    if (acked >= n) return
    if (Date.now() > deadline) throw new Error(`only ${acked} of ${n} ops acked`)
    await new Promise(r => setTimeout(r, 20))
  }
}

/* ── Cross-instance fan-out — TRD §15.2 ───────────────────────────────────── */

describe('Redis pub/sub fan-out', () => {
  it('delivers a broadcast from one instance to a room on another', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)

    /*
     * Two RoomManagers standing in for two server processes. The socket is
     * attached to the second; the broadcast is published from the first.
     *
     * v1 runs a single instance, so nothing in the rest of this file would
     * catch a fan-out that silently does nothing — and a fan-out that silently
     * does nothing means two people on one board simply never see each other
     * the day a second instance appears.
     */
    const roomsA = new RoomManager(0)
    const roomsB = new RoomManager(0)
    const fanoutA = new Fanout(roomsA)
    const fanoutB = new Fanout(roomsB)
    await Promise.all([fanoutA.start(), fanoutB.start()])

    const serverB = createServer(app)
    const gatewayB = attachGateway(serverB, { rooms: roomsB })
    await new Promise<void>(resolve => serverB.listen(0, '127.0.0.1', resolve))
    const portB = (serverB.address() as { port: number }).port

    const ticket = await getTicket(priya, boardId)
    const socket = new WebSocket(`ws://127.0.0.1:${portB}/ws?ticket=${ticket}`)
    const received: ServerMessage[] = []
    socket.on('message', data => received.push(JSON.parse(String(data)) as ServerMessage))
    await new Promise<void>(resolve => socket.once('open', () => resolve()))
    socket.send(JSON.stringify({ t: 'join', boardId, sinceSeq: 0 }))

    await waitUntil(() => received.some(m => m.t === 'join_ack'))

    fanoutA.publish(boardId, { t: 'board_renamed', name: 'Renamed elsewhere' })

    await waitUntil(() => received.some(m => m.t === 'board_renamed'))
    expect(received.find(m => m.t === 'board_renamed')).toMatchObject({
      name: 'Renamed elsewhere',
    })

    socket.close()
    await gatewayB.close()
    await Promise.all([fanoutA.stop(), fanoutB.stop()])
    await new Promise<void>(resolve => serverB.close(() => resolve()))
  })

  it('does not deliver an instance its own message twice', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)

    const a = await connect(priya, boardId)
    await a.join(boardId)

    const fanout = new Fanout(gateway.rooms)
    await fanout.start()
    fanout.publish(boardId, { t: 'board_renamed', name: 'Once' })

    // Long enough for a round trip through Redis to come back.
    await new Promise(r => setTimeout(r, 400))
    expect(a.all('board_renamed')).toHaveLength(1)

    await fanout.stop()
  })
})

/** Poll until a predicate holds, or fail with something legible. */
async function waitUntil(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition never became true')
    await new Promise(r => setTimeout(r, 10))
  }
}

/* ── Disconnect ───────────────────────────────────────────────────────────── */

describe('leaving', () => {
  it('tells the room when someone disconnects', async () => {
    const priya = await signUp()
    const marcus = await signUp('Marcus Feld')
    const boardId = await createBoard(priya)
    await prisma.boardMember.create({
      data: { boardId, userId: marcus.userId, role: 'EDITOR' },
    })

    const a = await connect(priya, boardId)
    const b = await connect(marcus, boardId)
    await a.join(boardId)
    const bAck = await b.join(boardId)

    b.close()
    const left = await a.waitFor('presence_leave')
    expect(left.sessionId).toBe(bAck.sessionId)
  })
})
