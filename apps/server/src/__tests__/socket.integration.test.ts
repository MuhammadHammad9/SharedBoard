import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
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
import { opService } from '../services/OpService.js'
import { permissionService } from '../services/PermissionService.js'
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
  closeCode: number | null = null
  private constructor(readonly socket: WebSocket) {}

  static async connect(ticket: string, onPort = port): Promise<Client> {
    const socket = new WebSocket(`ws://127.0.0.1:${onPort}/ws?ticket=${ticket}`)
    const client = new Client(socket)
    socket.on('message', data => {
      client.received.push(JSON.parse(String(data)) as ServerMessage)
    })
    socket.on('close', code => {
      client.closeCode = code
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

  async waitForClose(timeoutMs = 4_000): Promise<number> {
    const deadline = Date.now() + timeoutMs
    while (this.closeCode === null) {
      if (Date.now() > deadline) throw new Error('timed out waiting for close')
      await new Promise(r => setTimeout(r, 10))
    }
    return this.closeCode
  }

  close(): void {
    this.socket.close()
  }
}

const clients: Client[] = []
/** A guest's socket: the ticket is issued on the guest header — FR-AUTH-006. */
async function connectGuest(guestId: string, boardId: string): Promise<Client> {
  const response = await request(app)
    .post('/api/ws/ticket')
    .set({ 'x-coboard-guest': guestId })
    .send({ boardId })
  expect(response.status).toBe(200)
  const client = await Client.connect(response.body.ticket as string)
  clients.push(client)
  return client
}

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
  const keys = [...(await redis().keys('rl:*')), ...(await redis().keys('perm:*'))]
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

  it('does NOT nack a transient persist failure — the client must retry, not drop (R-SYNC-012)', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const a = await connect(priya, boardId)
    await a.join(boardId)

    const spy = vi
      .spyOn(opService, 'append')
      .mockRejectedValueOnce(new Error('connection terminated'))
    try {
      const op = createOp(sticky())
      a.send({ t: 'op', op })
      await new Promise(r => setTimeout(r, 200))
      // A nack is never retried; this was a hiccup, not a decision.
      expect(a.all('nack')).toHaveLength(0)
      expect(a.all('ack')).toHaveLength(0)

      // The client's retry, same id, succeeds and is stored once.
      a.send({ t: 'op', op })
      expect(await a.waitFor('ack')).toMatchObject({ ids: [op.id] })
      expect(await prisma.operation.count({ where: { boardId } })).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('broadcasts ops appended over REST, so the outbox fallback is not invisible (F-8)', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const watcher = await connect(priya, boardId)
    await watcher.join(boardId)

    const op = createOp(sticky())
    const response = await request(app)
      .post(`/api/boards/${boardId}/operations`)
      .set('authorization', `Bearer ${priya.token}`)
      .send({ ops: [op] })
    expect(response.status).toBe(200)

    const batch = await watcher.waitFor('op_batch')
    expect(batch.ops[0]).toMatchObject({ id: op.id, seq: 1 })
  })

  it('refuses the NEXT op from an editor demoted mid-session — defect P-1', async () => {
    const priya = await signUp()
    const marcus = await signUp('Marcus Feld')
    const boardId = await createBoard(priya)
    await prisma.boardMember.create({
      data: { boardId, userId: marcus.userId, role: 'EDITOR' },
    })
    const m = await connect(marcus, boardId)
    await m.join(boardId)

    const first = createOp(sticky())
    m.send({ t: 'op', op: first })
    expect(await m.waitFor('ack')).toMatchObject({ ids: [first.id] })

    // Demoted while connected. The socket was opened as EDITOR; that snapshot
    // of the role must not keep the door open.
    await prisma.boardMember.updateMany({
      where: { boardId, userId: marcus.userId },
      data: { role: 'VIEWER' },
    })
    await permissionService.invalidate(boardId, marcus.userId)

    const second = createOp(sticky())
    m.send({ t: 'op', op: second })
    expect(await m.waitFor('nack')).toMatchObject({
      id: second.id,
      code: NACK_CODES.FORBIDDEN,
    })
    expect(await prisma.operation.count({ where: { boardId } })).toBe(1)
  })

  it('refuses ops from a member removed mid-session', async () => {
    const priya = await signUp()
    const marcus = await signUp('Marcus Feld')
    const boardId = await createBoard(priya)
    await prisma.boardMember.create({
      data: { boardId, userId: marcus.userId, role: 'EDITOR' },
    })
    const m = await connect(marcus, boardId)
    await m.join(boardId)

    await prisma.boardMember.deleteMany({ where: { boardId, userId: marcus.userId } })
    await permissionService.invalidate(boardId, marcus.userId)

    const op = createOp(sticky())
    m.send({ t: 'op', op })
    expect(await m.waitFor('nack')).toMatchObject({
      id: op.id,
      code: NACK_CODES.FORBIDDEN,
    })
    expect(await prisma.operation.count({ where: { boardId } })).toBe(0)
  })

  it('lets a guest editor draw over the socket, and never broadcasts its guest id — P-3', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const guestId = randomUUID()
    await prisma.boardMember.create({
      data: { boardId, guestId, guestName: 'Marcus', role: 'EDITOR' },
    })
    const owner = await connect(priya, boardId)
    await owner.join(boardId)
    const guest = await connectGuest(guestId, boardId)
    await guest.join(boardId)

    const op = createOp(sticky())
    guest.send({ t: 'op', op })
    expect(await guest.waitFor('ack')).toMatchObject({ ids: [op.id] })
    expect(await owner.waitFor('op_batch')).toMatchObject({ ops: [{ id: op.id }] })

    // The guest's name reaches the room; its credential never does.
    const joined = await owner.waitFor('presence_join')
    expect(joined.user.name).toBe('Marcus')
    expect(JSON.stringify(owner.all('presence_join'))).not.toContain(guestId)
    expect(JSON.stringify(guest.all('join_ack'))).not.toContain(guestId)
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
    expect(
      await prisma.board.findUniqueOrThrow({ where: { id: boardId } }),
    ).toMatchObject({ currentSeq: 0 })
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
    expect(
      await prisma.board.findUniqueOrThrow({ where: { id: boardId } }),
    ).toMatchObject({ currentSeq: 100, objectCount: 100 })
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

  it('relays ops, presence and live ejection to a socket on another instance', async () => {
    /*
     * The socket on instance B never touches instance A's room. Before this
     * was wired, only `Fanout.publish` crossed — the op batch, the presence
     * join and the revoke stayed on the instance that produced them, so two
     * people on one board on different processes never saw each other.
     */
    const priya = await signUp()
    const boardId = await createBoard(priya)

    const roomsB = new RoomManager(0)
    const serverB = createServer(app)
    const gatewayB = attachGateway(serverB, { rooms: roomsB })
    await new Promise<void>(resolve => serverB.listen(0, '127.0.0.1', resolve))
    const portB = (serverB.address() as { port: number }).port
    const fanoutA = new Fanout(gateway.rooms)
    const fanoutB = new Fanout(roomsB)
    await Promise.all([fanoutA.start(), fanoutB.start()])

    try {
      const onB = await Client.connect(await getTicket(priya, boardId), portB)
      clients.push(onB)
      const ackB = await onB.join(boardId)
      const onA = await connect(priya, boardId)
      const ackA = await onA.join(boardId)
      // The arrival on A is told who is already on B, from Redis.
      expect(ackA.users.map(u => u.sessionId)).toContain(ackB.sessionId)
      // One colour rotation for the board across instances (R-UI-013): each
      // instance's room is fresh, so local rotation would give both slot 0.
      expect(ackA.colour).not.toBe(ackB.colour)

      // Presence: B hears about the arrival on A.
      await onB.waitFor('presence_join')

      // Ops: the batch flushed on A arrives on B, once.
      const op = createOp(sticky())
      onA.send({ t: 'op', op })
      const batch = await onB.waitFor('op_batch')
      expect(batch.ops.map(o => o.id)).toEqual([op.id])
      // ...and the author on A is not sent its own op back by B.
      await new Promise(r => setTimeout(r, 300))
      expect(onA.all('op_batch')).toHaveLength(0)

      // A live revoke issued on A ejects the socket on B (FLOWS §9.5).
      gateway.rooms.control(boardId, {
        action: 'revoke',
        identityKey: `u:${priya.userId}`,
      })
      expect(await onB.waitFor('access_revoked')).toEqual({ t: 'access_revoked' })
      expect(await onB.waitForClose()).toBe(CLOSE_CODES.FORBIDDEN)
    } finally {
      await Promise.all([fanoutA.stop(), fanoutB.stop()])
      await gatewayB.close()
      await new Promise<void>(resolve => serverB.close(() => resolve()))
    }
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

describe('live access changes — FLOWS §9.5, Phase 12c', () => {
  async function boardWithEditor() {
    const priya = await signUp()
    const marcus = await signUp('Marcus Feld')
    const boardId = await createBoard(priya)
    const invite = await request(app)
      .post(`/api/boards/${boardId}/members`)
      .set({ Authorization: `Bearer ${priya.token}` })
    expect(invite.status).toBe(422) // no body: refused, not a crash
    await prisma.boardMember.create({
      data: { boardId, userId: marcus.userId, role: 'EDITOR' },
    })
    const member = await prisma.boardMember.findFirstOrThrow({
      where: { boardId, userId: marcus.userId },
    })
    return { priya, marcus, boardId, memberId: member.id }
  }

  it('role:changed to viewer reaches the member without ejecting them', async () => {
    const { priya, marcus, boardId, memberId } = await boardWithEditor()
    const m = await connect(marcus, boardId)
    await m.join(boardId)

    const res = await request(app)
      .patch(`/api/boards/${boardId}/members/${memberId}`)
      .set({ Authorization: `Bearer ${priya.token}` })
      .send({ role: 'VIEWER' })
    expect(res.status).toBe(200)

    expect(await m.waitFor('role_changed')).toEqual({ t: 'role_changed', role: 'VIEWER' })
    await new Promise(r => setTimeout(r, 100))
    expect(m.closeCode).toBeNull()

    // And the server holds them to it.
    const op = createOp(sticky())
    m.send({ t: 'op', op })
    expect(await m.waitFor('nack')).toMatchObject({
      id: op.id,
      code: NACK_CODES.FORBIDDEN,
    })
  })

  it('removing a member sends access_revoked and closes their socket with 4003', async () => {
    const { priya, marcus, boardId, memberId } = await boardWithEditor()
    const m = await connect(marcus, boardId)
    await m.join(boardId)

    const res = await request(app)
      .delete(`/api/boards/${boardId}/members/${memberId}`)
      .set({ Authorization: `Bearer ${priya.token}` })
    expect(res.status).toBe(204)
    expect(await m.waitFor('access_revoked')).toEqual({ t: 'access_revoked' })
    expect(await m.waitForClose()).toBe(CLOSE_CODES.FORBIDDEN)
  })

  it('turning the link off ejects the guests who came through it — AT-22 server side', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const auth = { Authorization: `Bearer ${priya.token}` }
    const link = await request(app)
      .put(`/api/boards/${boardId}/share-link`)
      .set(auth)
      .send({ role: 'EDITOR' })
    const guestId = randomUUID()
    await request(app)
      .post(`/api/share/${link.body.link.token}/join`)
      .send({ guestId, name: 'Marcus' })

    const guest = await connectGuest(guestId, boardId)
    await guest.join(boardId)
    const owner = await connect(priya, boardId)
    await owner.join(boardId)

    await request(app).delete(`/api/boards/${boardId}/share-link`).set(auth)
    expect(await guest.waitFor('access_revoked')).toEqual({ t: 'access_revoked' })
    expect(await guest.waitForClose()).toBe(CLOSE_CODES.FORBIDDEN)
    // The owner is untouched.
    expect(owner.closeCode).toBeNull()
  })

  it('deleting the board shows everyone connected S-19 — AT-23 server side', async () => {
    const priya = await signUp()
    const marcus = await signUp('Marcus Feld')
    const dana = await signUp('Dana Ruiz')
    const boardId = await createBoard(priya)
    for (const u of [marcus, dana]) {
      await prisma.boardMember.create({
        data: { boardId, userId: u.userId, role: 'EDITOR' },
      })
    }
    const sockets = await Promise.all([priya, marcus, dana].map(u => connect(u, boardId)))
    for (const s of sockets) await s.join(boardId)

    await request(app)
      .delete(`/api/boards/${boardId}`)
      .set({ Authorization: `Bearer ${priya.token}` })

    for (const s of sockets) {
      expect(await s.waitFor('board_deleted')).toEqual({ t: 'board_deleted' })
      expect(await s.waitForClose()).toBe(CLOSE_CODES.NOT_FOUND)
    }
  })

  it('a rename reaches everyone live', async () => {
    const { priya, marcus, boardId } = await boardWithEditor()
    const m = await connect(marcus, boardId)
    await m.join(boardId)
    await request(app)
      .patch(`/api/boards/${boardId}`)
      .set({ Authorization: `Bearer ${priya.token}` })
      .send({ name: 'Q4 Planning' })
    expect(await m.waitFor('board_renamed')).toEqual({
      t: 'board_renamed',
      name: 'Q4 Planning',
    })
  })

  it('E-19: two simultaneous renames — last write wins, and everyone ends on it', async () => {
    const { priya, marcus, boardId } = await boardWithEditor()
    const m = await connect(marcus, boardId)
    await m.join(boardId)
    const rename = (name: string) =>
      request(app)
        .patch(`/api/boards/${boardId}`)
        .set({ Authorization: `Bearer ${priya.token}` })
        .send({ name })
    const results = await Promise.all([rename('Q4 Planning'), rename('Q4 Roadmap')])
    expect(results.map(r => r.status)).toEqual([200, 200])

    const stored = await request(app)
      .get(`/api/boards/${boardId}`)
      .set({ Authorization: `Bearer ${priya.token}` })
    const final = stored.body.board.name as string
    expect(['Q4 Planning', 'Q4 Roadmap']).toContain(final)

    // Both broadcasts arrive; the LAST one a client sees is the stored name.
    const deadline = Date.now() + 4_000
    while (m.all('board_renamed').length < 2 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 10))
    }
    expect(m.all('board_renamed').at(-1)?.name).toBe(final)
  })
})

/* ── Security review — findings 1, 3, 5, 10, 13, 14, 16 ──────────────────── */

describe('UPDATE payloads are validated — finding 1', () => {
  const update = (objectId: string, payload: unknown) => ({
    id: randomUUID(),
    type: 'UPDATE',
    objectId,
    payload,
  })

  async function boardWithSticky() {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const a = await connect(priya, boardId)
    await a.join(boardId)
    const note = sticky()
    a.send({ t: 'op', op: createOp(note) })
    await a.waitFor('ack')
    a.received.length = 0
    return { a, boardId, note }
  }

  const storedUpdates = (boardId: string) =>
    prisma.operation.count({ where: { boardId, type: 'UPDATE' } })

  it('nacks null points, an id or type change, and unknown keys — nothing persisted', async () => {
    const { a, boardId, note } = await boardWithSticky()
    for (const payload of [
      { points: null },
      { type: 'image' },
      { id: randomUUID() },
      { width: 'abc' },
      { notAField: 1 },
    ]) {
      const op = update(note.id, payload)
      a.send({ t: 'op', op })
      await waitUntil(() => a.all('nack').some(n => n.id === op.id))
      expect(a.all('nack').find(n => n.id === op.id)?.code).toBe(NACK_CODES.INVALID_OP)
    }
    expect(a.all('ack')).toHaveLength(0)
    expect(await storedUpdates(boardId)).toBe(0)
  })

  it('nacks an infinite coordinate sent as a raw 1e309 literal', async () => {
    const { a, boardId, note } = await boardWithSticky()
    const id = randomUUID()
    // JSON.stringify cannot produce this; JSON.parse turns it into Infinity.
    a.socket.send(
      `{"t":"op","op":{"id":"${id}","type":"UPDATE","objectId":"${note.id}","payload":{"x":1e309}}}`,
    )
    expect(await a.waitFor('nack')).toMatchObject({ id, code: NACK_CODES.INVALID_OP })
    expect(await storedUpdates(boardId)).toBe(0)
  })

  it("judges an update against its TARGET's type: a stroke colour is not a sticky colour", async () => {
    const { a, boardId, note } = await boardWithSticky()
    // A valid hex colour, so the wire schema passes it — but stickies use the
    // frozen palette (R-UI-014), and the merged object would be invalid.
    const bad = update(note.id, { color: '#123456' })
    // `text` is a sticky field too, so this one is fine; `url` is not.
    const wrongField = update(note.id, { simplified: true })
    const good = update(note.id, { color: '#FED7AA', x: 40, text: 'Moved' })
    a.send({ t: 'op_batch', ops: [bad, wrongField, good] })

    const ack = await a.waitFor('ack')
    expect(ack.ids).toEqual([good.id])
    await waitUntil(() => a.all('nack').length === 2)
    expect(
      a
        .all('nack')
        .map(n => n.id)
        .sort(),
    ).toEqual([bad.id, wrongField.id].sort())
    expect(await storedUpdates(boardId)).toBe(1)
  })

  it('judges an update against a CREATE earlier in the same batch', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const a = await connect(priya, boardId)
    await a.join(boardId)
    const note = sticky()
    const create = createOp(note)
    const bad = update(note.id, { color: '#123456' })
    a.send({ t: 'op_batch', ops: [create, bad] })
    expect((await a.waitFor('ack')).ids).toEqual([create.id])
    expect(await a.waitFor('nack')).toMatchObject({ id: bad.id })
  })

  it('nacks a CREATE whose payload id is not its objectId', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const a = await connect(priya, boardId)
    await a.join(boardId)
    const op = { ...createOp(sticky()), objectId: randomUUID() }
    a.send({ t: 'op', op })
    expect(await a.waitFor('nack')).toMatchObject({
      id: op.id,
      code: NACK_CODES.INVALID_OP,
    })
  })

  it('nacks an image whose url is not one of our uploads — finding 19', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const a = await connect(priya, boardId)
    await a.join(boardId)
    const id = randomUUID()
    const op: ClientOp = {
      id: randomUUID(),
      type: 'CREATE',
      objectId: id,
      payload: {
        ...(sticky() as object),
        id,
        type: 'image',
        url: 'https://tracker.example.com/pixel.png',
        naturalWidth: 10,
        naturalHeight: 10,
        cornerRadius: 0,
      } as unknown as BoardObject,
    }
    a.send({ t: 'op', op })
    expect(await a.waitFor('nack')).toMatchObject({
      id: op.id,
      code: NACK_CODES.INVALID_OP,
    })
    expect(await prisma.operation.count({ where: { boardId } })).toBe(0)
  })
})

describe('op id collisions are decisions, not retries — finding 13', () => {
  it('nacks an op id already stored on ANOTHER board, instead of failing the batch forever', async () => {
    const priya = await signUp()
    const first = await createBoard(priya)
    const second = await createBoard(priya)
    const a = await connect(priya, first)
    await a.join(first)
    const op = createOp(sticky())
    a.send({ t: 'op', op })
    await a.waitFor('ack')

    const b = await connect(priya, second)
    await b.join(second)
    const fresh = createOp(sticky())
    // Same op id, different board — plus an innocent op in the same batch.
    b.send({ t: 'op_batch', ops: [{ ...createOp(sticky()), id: op.id }, fresh] })
    expect(await b.waitFor('nack')).toMatchObject({
      id: op.id,
      code: NACK_CODES.INVALID_OP,
    })
    expect((await b.waitFor('ack')).ids).toEqual([fresh.id])
    expect(await prisma.operation.count({ where: { boardId: second } })).toBe(1)
  })

  it('nacks a duplicated op id within one batch and stores the rest', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const a = await connect(priya, boardId)
    await a.join(boardId)
    const dup = createOp(sticky())
    const fine = createOp(sticky())
    a.send({ t: 'op_batch', ops: [dup, { ...createOp(sticky()), id: dup.id }, fine] })
    expect(await a.waitFor('nack')).toMatchObject({ id: dup.id })
    expect((await a.waitFor('ack')).ids).toEqual([fine.id])
  })
})

describe('transient failures are not decisions', () => {
  it('a non-AuthError from the permission check is NOT nacked FORBIDDEN — finding 5', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const a = await connect(priya, boardId)
    await a.join(boardId)

    const spy = vi
      .spyOn(permissionService, 'assertCanEdit')
      .mockRejectedValueOnce(new Error('redis: connection reset'))
    const op = createOp(sticky())
    a.send({ t: 'op', op })
    await new Promise(r => setTimeout(r, 200))
    spy.mockRestore()
    // Silence: the client's ack timeout retries. A nack would discard the work.
    expect(a.all('nack')).toHaveLength(0)
    expect(a.all('ack')).toHaveLength(0)

    a.send({ t: 'op', op })
    expect((await a.waitFor('ack')).ids).toEqual([op.id])
  })

  it('a database error during join closes that socket with 1011 and keeps the server up — finding 3', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const a = await connect(priya, boardId)

    const spy = vi
      .spyOn(opService, 'currentSeq')
      .mockRejectedValueOnce(new Error('connection terminated unexpectedly'))
    a.send({ t: 'join', boardId, sinceSeq: 0 })
    expect(await a.waitForClose()).toBe(CLOSE_CODES.INTERNAL_ERROR)
    spy.mockRestore()
    expect(gateway.rooms.size(boardId)).toBe(0)

    // The process — and every other room — is still serving.
    const b = await connect(priya, boardId)
    expect((await b.join(boardId)).t).toBe('join_ack')
  })
})

describe('sockets that never join, and the room cap — finding 10', () => {
  it('closes a socket that has not joined within the deadline', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const serverB = createServer(app)
    const gatewayB = attachGateway(serverB, {
      rooms: new RoomManager(0),
      joinTimeoutMs: 200,
    })
    await new Promise<void>(resolve => serverB.listen(0, '127.0.0.1', resolve))
    const portB = (serverB.address() as { port: number }).port
    try {
      const idle = await Client.connect(await getTicket(priya, boardId), portB)
      const joined = await Client.connect(await getTicket(priya, boardId), portB)
      await joined.join(boardId)

      expect(await idle.waitForClose()).toBe(CLOSE_CODES.POLICY_VIOLATION)
      await new Promise(r => setTimeout(r, 150))
      expect(joined.closeCode).toBeNull()
      joined.close()
    } finally {
      await gatewayB.close()
      await new Promise<void>(resolve => serverB.close(() => resolve()))
    }
  })

  it('re-checks the room cap at join, not only at upgrade', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    // Upgraded while the room was empty…
    const late = await connect(priya, boardId)
    // …and the room filled before it joined.
    const fakes = Array.from({ length: 50 }, () => ({
      id: randomUUID(),
      boardId,
      joined: true,
    }))
    for (const fake of fakes) gateway.rooms.join(fake as never)
    try {
      late.send({ t: 'join', boardId, sinceSeq: 0 })
      expect(await late.waitForClose()).toBe(CLOSE_CODES.RATE_LIMITED)
    } finally {
      for (const fake of fakes) gateway.rooms.leave(fake as never)
    }
  })

  it('rate-limits ticket minting per identity', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const statuses: number[] = []
    for (let i = 0; i < 31; i++) {
      const response = await request(app)
        .post('/api/ws/ticket')
        .set({ Authorization: `Bearer ${priya.token}` })
        .send({ boardId })
      statuses.push(response.status)
    }
    expect(statuses.slice(0, 30).every(s => s === 200)).toBe(true)
    expect(statuses[30]).toBe(429)
  })
})

describe('a socket that closes mid-join leaves no ghost — finding 14', () => {
  it('does not add a session whose socket closed during the colour lookup', async () => {
    const { presenceService } = await import('../services/PresenceService.js')
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const a = await connect(priya, boardId)

    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    const spy = vi
      .spyOn(presenceService, 'nextColourSlot')
      .mockImplementationOnce(async () => {
        await gate
        return 0
      })
    a.send({ t: 'join', boardId, sinceSeq: 0 })
    await new Promise(r => setTimeout(r, 50))
    a.close()
    await a.waitForClose()
    await new Promise(r => setTimeout(r, 50))
    release()
    await new Promise(r => setTimeout(r, 100))
    spy.mockRestore()

    expect(gateway.rooms.size(boardId)).toBe(0)
  })
})

describe('permanent delete notifies the room — finding 16', () => {
  it('a board deleted without being trashed first shows everyone S-19', async () => {
    const priya = await signUp()
    const marcus = await signUp('Marcus Feld')
    const boardId = await createBoard(priya)
    await prisma.boardMember.create({
      data: { boardId, userId: marcus.userId, role: 'EDITOR' },
    })
    const m = await connect(marcus, boardId)
    await m.join(boardId)

    const gone = await request(app)
      .post(`/api/boards/${boardId}/permanent-delete`)
      .set({ Authorization: `Bearer ${priya.token}` })
      .send({ confirmName: 'Q3 Retrospective' })
    expect(gone.status).toBe(204)

    expect(await m.waitFor('board_deleted')).toEqual({ t: 'board_deleted' })
    expect(await m.waitForClose()).toBe(CLOSE_CODES.NOT_FOUND)
  })
})

describe('presence is throttled server-side — finding 11', () => {
  it('relays at most the burst of a cursor flood, silently, and stays up', async () => {
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

    for (let i = 0; i < 1_000; i++) a.send({ t: 'cursor', x: i, y: i })
    await new Promise(r => setTimeout(r, 500))
    const relayed = b.all('cursor').length
    expect(relayed).toBeGreaterThan(0)
    // Capacity 160 plus at most a second of refill at 80/s.
    expect(relayed).toBeLessThan(300)

    // Nothing was nacked or closed: dropping presence is silent.
    expect(a.closeCode).toBeNull()
    const op = createOp(sticky())
    a.send({ t: 'op', op })
    expect((await a.waitFor('ack')).ids).toEqual([op.id])
  })
})
