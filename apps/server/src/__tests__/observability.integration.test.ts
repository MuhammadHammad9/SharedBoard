import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import WebSocket from 'ws'
import { NACK_CODES, type ClientOp, type ServerMessage } from '@coboard/shared'
import { createApp } from '../http/app.js'
import { attachGateway, type Gateway } from '../ws/gateway.js'
import { RoomManager } from '../ws/RoomManager.js'
import { prisma } from '../lib/prisma.js'
import { closeRedis, redis, waitForRedis } from '../lib/redis.js'
import { captureLogs, type LogLine } from '../lib/logger.js'
import { resetEnvCache } from '../lib/env.js'
import { parseRedisMemory, poolLimit } from '../lib/metrics.js'

/**
 * Observability — Phase 15e, TRD §15.4, PRD §8.1.
 *
 * Three promises, each checked end to end against the real app:
 * the request id travels header → logs → error envelope; `/metrics` is
 * protected and moves when the system does; and every op rejection is logged
 * with its code, board, actor and correlation id.
 */

let app: ReturnType<typeof createApp>
let server: Server
let gateway: Gateway
let port: number

const password = 'correct-horse-1'
let counter = 0

interface Actor {
  token: string
  userId: string
}

async function signUp(displayName: string): Promise<Actor> {
  const email = `obs${++counter}.${Date.now()}@example.com`
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
    .send({ name: 'Onboarding Journey Map' })
  expect(response.status).toBe(201)
  return response.body.board.id as string
}

function stickyOp(): ClientOp {
  const objectId = randomUUID()
  return {
    id: randomUUID(),
    type: 'CREATE',
    objectId,
    payload: {
      id: objectId,
      type: 'sticky',
      x: 10,
      y: 20,
      width: 200,
      height: 200,
      rotation: 0,
      zIndex: 'a0000001',
      opacity: 1,
      createdBy: 'test',
      createdAt: 1_760_000_000_000,
      updatedAt: 1_760_000_000_000,
      text: 'Activation drop-off',
      color: '#FEF08A',
      fontSize: 16,
      textAlign: 'left',
    },
  } as ClientOp
}

async function connect(actor: Actor, boardId: string) {
  const ticket = await request(app)
    .post('/api/ws/ticket')
    .set({ Authorization: `Bearer ${actor.token}` })
    .send({ boardId })
  expect(ticket.status).toBe(200)
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket.body.ticket}`)
  const received: ServerMessage[] = []
  socket.on('message', data => received.push(JSON.parse(String(data)) as ServerMessage))
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  sockets.push(socket)
  const waitFor = async <T extends ServerMessage['t']>(t: T) => {
    const deadline = Date.now() + 4_000
    for (;;) {
      const found = received.find(m => m.t === t)
      if (found) return found as Extract<ServerMessage, { t: T }>
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${t}`)
      await new Promise(r => setTimeout(r, 10))
    }
  }
  const send = (message: unknown) => socket.send(JSON.stringify(message))
  send({ t: 'join', boardId, sinceSeq: 0 })
  await waitFor('join_ack')
  return { send, waitFor }
}

const sockets: WebSocket[] = []

/** The value of one series in a Prometheus text exposition, or undefined. */
function sample(text: string, series: string): number | undefined {
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue
    const space = line.lastIndexOf(' ')
    if (line.slice(0, space) === series) return Number(line.slice(space + 1))
  }
  return undefined
}

async function scrape(): Promise<string> {
  const response = await request(app).get('/metrics')
  expect(response.status).toBe(200)
  return response.text
}

beforeAll(async () => {
  app = createApp()
  await waitForRedis()
  server = createServer(app)
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
  for (const socket of sockets.splice(0)) socket.close()
  delete process.env.METRICS_TOKEN
  resetEnvCache()
})

afterAll(async () => {
  await gateway.close()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await prisma.user.deleteMany({})
  await prisma.$disconnect()
  await closeRedis()
})

/* ── Request ids ──────────────────────────────────────────────────────────── */

describe('x-request-id', () => {
  it('mints an id when none is sent and echoes it', async () => {
    const response = await request(app).get('/health')
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f]{8}$/)
  })

  it('keeps a sane incoming id', async () => {
    const response = await request(app).get('/health').set('x-request-id', 'edge-7F3a_91')
    expect(response.headers['x-request-id']).toBe('edge-7F3a_91')
  })

  it('replaces a hostile or oversized id rather than echoing or logging it', async () => {
    for (const hostile of [
      'abc\\n{"level":60,"msg":"forged"}',
      'a'.repeat(65),
      '../../etc/passwd',
      '<script>',
      'with space',
    ]) {
      const response = await request(app).get('/health').set('x-request-id', hostile)
      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f]{8}$/)
    }
  })

  it('is the correlationId of an error envelope, so "Ref:" finds the logs', async () => {
    const capture = captureLogs('info')
    try {
      const response = await request(app)
        .get('/api/boards')
        .set('x-request-id', 'client-1a2b3c4d')
      expect(response.status).toBe(401)
      expect(response.headers['x-request-id']).toBe('client-1a2b3c4d')
      expect(response.body.error.correlationId).toBe('client-1a2b3c4d')
      // The rejection was logged on the request's child logger.
      expect(capture.lines).toContainEqual(
        expect.objectContaining({
          requestId: 'client-1a2b3c4d',
          correlationId: 'client-1a2b3c4d',
          msg: 'request rejected',
        }),
      )

      const notFound = await request(app).get('/api/nowhere')
      expect(notFound.status).toBe(404)
      expect(notFound.body.error.correlationId).toBe(notFound.headers['x-request-id'])
    } finally {
      capture.stop()
    }
  })
})

/* ── /metrics ─────────────────────────────────────────────────────────────── */

describe('GET /metrics', () => {
  it('is open in development and test when no token is configured', async () => {
    const response = await request(app).get('/metrics')
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('text/plain')
  })

  it('requires the bearer token when METRICS_TOKEN is set', async () => {
    process.env.METRICS_TOKEN = 'scrape-token-0123456789'
    resetEnvCache()

    expect((await request(app).get('/metrics')).status).toBe(401)
    expect(
      (
        await request(app)
          .get('/metrics')
          .set('Authorization', 'Bearer wrong-token-000000')
      ).status,
    ).toBe(401)
    const ok = await request(app)
      .get('/metrics')
      .set('Authorization', 'Bearer scrape-token-0123456789')
    expect(ok.status).toBe(200)
    expect(ok.text).toContain('coboard_http_requests_total')
  })

  it('is disabled in production when no token is configured', async () => {
    const previous = process.env.NODE_ENV
    const previousSmtp = process.env.SMTP_URL
    process.env.NODE_ENV = 'production'
    // Production refuses to boot without SMTP (finding 15); any value will do,
    // nothing is sent.
    process.env.SMTP_URL = 'smtp://127.0.0.1:1'
    resetEnvCache()
    try {
      expect((await request(app).get('/metrics')).status).toBe(404)
    } finally {
      process.env.NODE_ENV = previous
      if (previousSmtp === undefined) delete process.env.SMTP_URL
      else process.env.SMTP_URL = previousSmtp
      resetEnvCache()
    }
  })

  it('exposes the eight TRD §15.4 signals', async () => {
    await request(app).get('/health')
    const text = await scrape()
    for (const name of [
      'coboard_http_requests_total',
      'coboard_op_persist_duration_seconds_bucket',
      'coboard_ws_connection_attempts_total',
      'coboard_ws_connection_failures_total',
      'coboard_ws_connected_sockets',
      'coboard_pg_pool_connections',
      'coboard_pg_pool_connections_max',
      'coboard_redis_memory_used_bytes',
      'coboard_redis_maxmemory_bytes',
      'coboard_ops_accepted_total',
      'coboard_ops_rejected_total',
      'coboard_job_failures_total',
    ]) {
      expect(text, name).toContain(name)
    }
    expect(
      sample(
        text,
        'coboard_http_requests_total{route="/health",method="GET",status_class="2xx"}',
      ),
    ).toBeGreaterThan(0)
    expect(sample(text, 'coboard_redis_memory_used_bytes')).toBeGreaterThan(0)
    expect(sample(text, 'coboard_pg_pool_connections{state="open"}')).toBeGreaterThan(0)
  })

  it('labels routes by pattern, never by concrete id', async () => {
    const priya = await signUp('Priya Raman')
    const boardId = await createBoard(priya)
    await request(app)
      .get(`/api/boards/${boardId}/members`)
      .set({ Authorization: `Bearer ${priya.token}` })
    const text = await scrape()
    expect(text).not.toContain(boardId)
    expect(text).toContain('route="/api/boards/:id/members/"')
  })

  it('moves when an op is persisted and when a socket connects', async () => {
    const priya = await signUp('Priya Raman')
    const boardId = await createBoard(priya)

    const before = await scrape()
    const acceptedBefore =
      sample(before, 'coboard_ops_accepted_total{transport="ws"}') ?? 0
    const persistsBefore =
      sample(before, 'coboard_op_persist_duration_seconds_count') ?? 0
    const attemptsBefore = sample(before, 'coboard_ws_connection_attempts_total') ?? 0

    const client = await connect(priya, boardId)
    const op = stickyOp()
    client.send({ t: 'op', op })
    const ack = await client.waitFor('ack')
    expect(ack.ids).toEqual([op.id])

    const after = await scrape()
    expect(sample(after, 'coboard_ops_accepted_total{transport="ws"}')).toBe(
      acceptedBefore + 1,
    )
    expect(sample(after, 'coboard_op_persist_duration_seconds_count')).toBe(
      persistsBefore + 1,
    )
    expect(sample(after, 'coboard_ws_connection_attempts_total')).toBe(attemptsBefore + 1)
    expect(sample(after, 'coboard_ws_connected_sockets')).toBeGreaterThanOrEqual(1)
  })

  it('counts a refused upgrade as a connection failure', async () => {
    const before = await scrape()
    const failures =
      sample(before, 'coboard_ws_connection_failures_total{reason="401"}') ?? 0
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=forged`)
    await new Promise(resolve => socket.once('error', resolve))
    const after = await scrape()
    expect(sample(after, 'coboard_ws_connection_failures_total{reason="401"}')).toBe(
      failures + 1,
    )
  })
})

/* ── Op rejection logs ────────────────────────────────────────────────────── */

describe('op rejections', () => {
  async function viewerOnBoard() {
    const priya = await signUp('Priya Raman')
    const marcus = await signUp('Marcus Feld')
    const boardId = await createBoard(priya)
    await prisma.boardMember.create({
      data: { boardId, userId: marcus.userId, role: 'VIEWER' },
    })
    return { marcus, boardId }
  }

  const rejections = (lines: LogLine[]) => lines.filter(l => l.msg === 'op rejected')

  it('logs a forged socket op with code, board, actor and correlation id', async () => {
    const { marcus, boardId } = await viewerOnBoard()
    const before = sample(
      await scrape(),
      'coboard_ops_rejected_total{transport="ws",code="FORBIDDEN"}',
    )

    const capture = captureLogs('warn')
    try {
      const client = await connect(marcus, boardId)
      const op = stickyOp()
      client.send({ t: 'op', op })
      const nack = await client.waitFor('nack')
      expect(nack.code).toBe(NACK_CODES.FORBIDDEN)

      const [line] = rejections(capture.lines)
      expect(line).toMatchObject({
        level: 40,
        transport: 'ws',
        code: 'FORBIDDEN',
        boardId,
        actor: marcus.userId,
        opId: op.id,
      })
      expect(line?.sessionId).toEqual(expect.any(String))
      expect(line?.correlationId).toBe(`${String(line?.sessionId)}:${op.id}`)
    } finally {
      capture.stop()
    }

    const after = sample(
      await scrape(),
      'coboard_ops_rejected_total{transport="ws",code="FORBIDDEN"}',
    )
    expect(after).toBe((before ?? 0) + 1)
  })

  it('logs a malformed socket op as INVALID_OP', async () => {
    const priya = await signUp('Priya Raman')
    const boardId = await createBoard(priya)
    const capture = captureLogs('warn')
    try {
      const client = await connect(priya, boardId)
      const opId = randomUUID()
      client.send({ t: 'op', op: { id: opId, type: 'CREATE', objectId: 'nope' } })
      expect((await client.waitFor('nack')).code).toBe(NACK_CODES.INVALID_OP)
      expect(rejections(capture.lines)).toContainEqual(
        expect.objectContaining({
          code: 'INVALID_OP',
          opId,
          actor: priya.userId,
          boardId,
        }),
      )
    } finally {
      capture.stop()
    }
  })

  it('logs a REST op rejection with the request id as correlation id', async () => {
    const { marcus, boardId } = await viewerOnBoard()
    const op = stickyOp()
    const capture = captureLogs('warn')
    try {
      const response = await request(app)
        .post(`/api/boards/${boardId}/operations`)
        .set({ Authorization: `Bearer ${marcus.token}`, 'x-request-id': 'rest-op-42' })
        .send({ ops: [op] })
      expect(response.status).toBe(403)
      expect(response.body.error.correlationId).toBe('rest-op-42')
      expect(rejections(capture.lines)).toContainEqual(
        expect.objectContaining({
          level: 40,
          transport: 'rest',
          code: 'FORBIDDEN',
          boardId,
          actor: marcus.userId,
          opId: op.id,
          correlationId: 'rest-op-42',
          requestId: 'rest-op-42',
        }),
      )
    } finally {
      capture.stop()
    }
    // Nothing was written: the rejection is logged, not half-applied.
    expect(await prisma.operation.count({ where: { boardId } })).toBe(0)
  })

  it('logs a malformed REST batch as INVALID_OP without echoing junk ids', async () => {
    const priya = await signUp('Priya Raman')
    const boardId = await createBoard(priya)
    const capture = captureLogs('warn')
    try {
      const response = await request(app)
        .post(`/api/boards/${boardId}/operations`)
        .set({ Authorization: `Bearer ${priya.token}` })
        .send({ ops: [{ id: 'x'.repeat(500), type: 'CREATE' }] })
      expect(response.status).toBe(422)
      expect(rejections(capture.lines)).toContainEqual(
        expect.objectContaining({ code: 'INVALID_OP', opId: 'unknown', boardId }),
      )
    } finally {
      capture.stop()
    }
  })
})

/* ── Pure helpers ─────────────────────────────────────────────────────────── */

describe('metric helpers', () => {
  it('reads used_memory and maxmemory from INFO memory', () => {
    const info =
      '# Memory\r\nused_memory:1048576\r\nused_memory_human:1.00M\r\nmaxmemory:4194304\r\n'
    expect(parseRedisMemory(info)).toEqual({ used: 1_048_576, max: 4_194_304 })
  })

  it('takes the pool size from connection_limit when the URL sets one', () => {
    expect(poolLimit('postgresql://u:p@db:5432/coboard?connection_limit=17')).toBe(17)
    expect(poolLimit('postgresql://u:p@db:5432/coboard')).toBeGreaterThanOrEqual(3)
  })
})
