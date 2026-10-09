/**
 * Load test — PRD §7.2, Phase 15d (gap P15-6).
 *
 *   pnpm load-test                                   # 50 users, 100 ops/s, 60 s
 *   pnpm load-test --users 10 --rate 20 --seconds 10 # a quick shakedown
 *   pnpm load-test --url http://staging.internal:3000
 *
 * What it does, all through the real API and the real socket protocol:
 *
 *   1. Signs in a load-test owner (registering it on first use), creates a
 *      board and turns its share link on as EDITOR.
 *   2. Joins N-1 guests through that link — the path that has no per-IP
 *      registration limit, so the test can run repeatedly — and opens N
 *      sockets (owner + guests) with the ticket → upgrade → join handshake.
 *   3. Sends CREATE ops at an aggregate RATE per second for SECONDS,
 *      round-robin across the sockets. Each socket's share must stay under the
 *      server's per-session token bucket (RATE_LIMIT_OPS_PER_SEC), or every
 *      nack would be the test's own fault.
 *   4. Measures ack latency (send → ack), nacks by code, and broadcast fan-out
 *      latency (send → receipt by each OTHER socket), and counts broadcasts
 *      that never arrived.
 *   5. Reads the op log back through `GET /api/boards/:id/operations` and
 *      checks every acked op id is there EXACTLY once, at the seq it was acked
 *      with — the zero-committed-op-loss guarantee (R-SYNC-012).
 *
 * Exits non-zero if ack p95 > 100 ms (the TRD §15.4 persist threshold, which
 * is the stricter of the two server-side budgets), if any acked op is missing
 * or duplicated, if any op is nacked, if any op is never acked, or if a socket
 * closes unexpectedly.
 *
 * The board is moved to Trash at the end unless `--keep` is passed.
 * `--timeline` prints ack p95 and max per second of the run, which is how a
 * periodic stall (a snapshot every 500 ops) is told apart from steady queueing.
 */
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { RATE_LIMIT_OPS_PER_SEC } from '../packages/shared/src/constants.js'

/* ── Options ──────────────────────────────────────────────────────────────── */

const { values: flags } = parseArgs({
  options: {
    users: { type: 'string', default: '50' },
    rate: { type: 'string', default: '100' },
    seconds: { type: 'string', default: '60' },
    url: { type: 'string', default: 'http://localhost:3000' },
    'ack-p95-ms': { type: 'string', default: '100' },
    keep: { type: 'boolean', default: false },
    timeline: { type: 'boolean', default: false },
  },
})

const USERS = Number(flags.users)
const RATE = Number(flags.rate)
const SECONDS = Number(flags.seconds)
const BASE = String(flags.url).replace(/\/$/, '')
const ACK_P95_BUDGET_MS = Number(flags['ack-p95-ms'])
const WS_URL = `${BASE.replace(/^http/, 'ws')}/ws`

for (const [name, value] of Object.entries({ USERS, RATE, SECONDS, ACK_P95_BUDGET_MS })) {
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`--${name.toLowerCase()} must be a positive number`)
    process.exit(2)
  }
}
if (USERS < 2) {
  console.error('--users must be at least 2: fan-out needs someone to receive')
  process.exit(2)
}
// Leave a margin under the bucket: sends are not perfectly evenly spaced.
if (RATE / USERS > RATE_LIMIT_OPS_PER_SEC * 0.8) {
  console.error(
    `${RATE} ops/s over ${USERS} users is ${(RATE / USERS).toFixed(1)} per session, ` +
      `above 80% of the server's ${RATE_LIMIT_OPS_PER_SEC}/s per-session limit. ` +
      'Add users or lower the rate.',
  )
  process.exit(2)
}

/* ── WebSocket: the global one (Node 22+) or the server's `ws` (Node 20) ──── */

interface WsEvent {
  data?: unknown
  code?: number
}
interface WsLike {
  readyState: number
  send(data: string): void
  close(): void
  addEventListener(type: string, listener: (event: WsEvent) => void): void
}
type WsCtor = new (url: string) => WsLike

const WebSocketImpl: WsCtor =
  (globalThis as { WebSocket?: WsCtor }).WebSocket ??
  (createRequire(new URL('../apps/server/package.json', import.meta.url))('ws') as WsCtor)

/* ── HTTP helpers ─────────────────────────────────────────────────────────── */

async function http<T>(
  method: string,
  path: string,
  options: { token?: string; guest?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-request-id': `loadtest-${randomUUID().slice(0, 8)}`,
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.guest ? { 'x-coboard-guest': options.guest } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
  const text = await response.text()
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T }
}

async function must<T>(
  label: string,
  call: Promise<{ status: number; body: T }>,
  ok = [200, 201],
): Promise<T> {
  const { status, body } = await call
  if (!ok.includes(status)) {
    throw new Error(`${label} failed: HTTP ${status} ${JSON.stringify(body)}`)
  }
  return body
}

/* ── Setup through the real API ───────────────────────────────────────────── */

const OWNER = {
  email: 'load-test-owner@example.com',
  password: 'load-test-password-1',
  displayName: 'Load Test Owner',
}

async function ownerToken(): Promise<string> {
  const login = await http<{ accessToken: string }>('POST', '/api/auth/login', {
    body: { email: OWNER.email, password: OWNER.password },
  })
  if (login.status === 200) return login.body.accessToken
  const registered = await must(
    'register owner',
    http<{ accessToken: string }>('POST', '/api/auth/register', { body: OWNER }),
  )
  return registered.accessToken
}

interface Participant {
  name: string
  token?: string
  guest?: string
}

async function setup(): Promise<{
  boardId: string
  owner: string
  people: Participant[]
}> {
  const owner = await ownerToken()
  const { board } = await must(
    'create board',
    http<{ board: { id: string } }>('POST', '/api/boards', {
      token: owner,
      body: { name: `Load test ${new Date().toISOString().slice(0, 16)}` },
    }),
  )
  const { link } = await must(
    'enable share link',
    http<{ link: { token: string } }>('PUT', `/api/boards/${board.id}/share-link`, {
      token: owner,
      body: { role: 'EDITOR' },
    }),
  )

  const people: Participant[] = [{ name: OWNER.displayName, token: owner }]
  for (let i = 1; i < USERS; i++) {
    const guest = randomUUID()
    const name = `Guest ${String(i).padStart(2, '0')}`
    await must(
      `guest ${i} join`,
      http('POST', `/api/share/${link.token}/join`, { body: { guestId: guest, name } }),
    )
    people.push({ name, guest })
  }
  return { boardId: board.id, owner, people }
}

/* ── Measurement state ────────────────────────────────────────────────────── */

interface Sent {
  at: number
  sender: number
  ackedSeq?: number
  ackMs?: number
  nack?: string
  /** Sockets other than the sender that have received the broadcast. */
  delivered: number
}

const sent = new Map<string, Sent>()
const ackLatencies: number[] = []
const fanoutLatencies: number[] = []
const nacks = new Map<string, number>()
const unexpectedCloses: string[] = []
let sendsRefused = 0
let measuring = true

/* ── Clients ──────────────────────────────────────────────────────────────── */

class LoadClient {
  private socket!: WsLike
  joined = false
  private closing = false

  constructor(
    readonly index: number,
    readonly person: Participant,
    readonly boardId: string,
  ) {}

  async connect(): Promise<void> {
    const { ticket } = await must(
      `ticket for ${this.person.name}`,
      http<{ ticket: string }>('POST', '/api/ws/ticket', {
        ...(this.person.token ? { token: this.person.token } : {}),
        ...(this.person.guest ? { guest: this.person.guest } : {}),
        body: { boardId: this.boardId },
      }),
    )
    this.socket = new WebSocketImpl(`${WS_URL}?ticket=${ticket}`)
    await new Promise<void>((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve())
      this.socket.addEventListener('error', () =>
        reject(new Error(`socket ${this.index} failed to open`)),
      )
    })
    this.socket.addEventListener('message', event => this.onMessage(String(event.data)))
    this.socket.addEventListener('close', event => {
      if (!this.closing) unexpectedCloses.push(`client ${this.index}: code ${event.code}`)
    })

    const joined = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`client ${this.index} join timed out`)),
        10_000,
      )
      this.onJoined = () => {
        clearTimeout(timer)
        resolve()
      }
    })
    this.send({ t: 'join', boardId: this.boardId, sinceSeq: 0 })
    await joined
  }

  private onJoined: () => void = () => undefined

  send(message: unknown): boolean {
    if (this.socket.readyState !== 1) return false
    this.socket.send(JSON.stringify(message))
    return true
  }

  private onMessage(raw: string): void {
    const now = performance.now()
    const message = JSON.parse(raw) as
      | { t: 'join_ack' }
      | { t: 'ack'; ids: string[]; seqs: number[] }
      | { t: 'nack'; id: string; code: string }
      | { t: 'op_batch'; ops: Array<{ id: string }> }
      | { t: string }

    switch (message.t) {
      case 'join_ack':
        this.joined = true
        this.onJoined()
        return
      case 'ack': {
        const { ids, seqs } = message as { ids: string[]; seqs: number[] }
        ids.forEach((id, i) => {
          const op = sent.get(id)
          if (!op || op.ackMs !== undefined) return
          op.ackMs = now - op.at
          op.ackedSeq = seqs[i]
          if (measuring) ackLatencies.push(op.ackMs)
        })
        return
      }
      case 'nack': {
        const { id, code } = message as { id: string; code: string }
        const op = sent.get(id)
        if (op) op.nack = code
        nacks.set(code, (nacks.get(code) ?? 0) + 1)
        return
      }
      case 'op_batch':
        for (const { id } of (message as { ops: Array<{ id: string }> }).ops) {
          const op = sent.get(id)
          // Only ops this run sent, received by someone other than the sender.
          if (!op || op.sender === this.index) continue
          op.delivered += 1
          if (measuring) fanoutLatencies.push(now - op.at)
        }
        return
    }
  }

  close(): void {
    this.closing = true
    this.socket.close()
  }
}

/* ── The op ───────────────────────────────────────────────────────────────── */

let seed = 0
function createOp(author: string) {
  seed += 1
  const objectId = randomUUID()
  return {
    id: randomUUID(),
    type: 'CREATE' as const,
    objectId,
    payload: {
      id: objectId,
      type: 'sticky',
      x: (seed % 100) * 220,
      y: Math.floor(seed / 100) * 220,
      width: 200,
      height: 200,
      rotation: 0,
      zIndex: `a${seed.toString(36).padStart(6, '0')}`,
      opacity: 1,
      createdBy: author,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      text: `Load ${seed}`,
      color: '#FEF08A',
      fontSize: 16,
      textAlign: 'left',
    },
  }
}

/* ── Statistics ───────────────────────────────────────────────────────────── */

function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, rank)]!
}

const ms = (value: number) => (Number.isNaN(value) ? 'n/a' : `${value.toFixed(1)} ms`)

const sleep = (duration: number) => new Promise(r => setTimeout(r, duration))

/* ── Run ──────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  console.log(
    `CoBoard load test: ${USERS} users, ${RATE} ops/s for ${SECONDS} s against ${BASE}`,
  )
  const setupStarted = performance.now()
  const { boardId, owner, people } = await setup()
  const clients = people.map((person, i) => new LoadClient(i, person, boardId))
  // Sequential connects: the ticket and join path is not what is under test,
  // and 50 parallel upgrades would measure connection storms instead.
  for (const client of clients) await client.connect()
  console.log(
    `  board ${boardId}: ${clients.length} sockets joined in ${(
      (performance.now() - setupStarted) /
      1000
    ).toFixed(1)} s`,
  )

  // Heartbeat, as the real client does — R-SYNC-032's idle sweep is 60 s.
  const heartbeat = setInterval(() => {
    for (const client of clients) client.send({ t: 'ping' })
  }, 20_000)

  const total = Math.round(RATE * SECONDS)
  const started = performance.now()
  let issued = 0
  let next = 0
  while (issued < total) {
    const due = Math.min(total, Math.floor(((performance.now() - started) / 1000) * RATE))
    while (issued < due) {
      const client = clients[next]!
      next = (next + 1) % clients.length
      const op = createOp(client.person.name)
      sent.set(op.id, { at: performance.now(), sender: client.index, delivered: 0 })
      if (!client.send({ t: 'op', op })) {
        sent.delete(op.id)
        sendsRefused += 1
      }
      issued += 1
    }
    await sleep(5)
  }
  const sendSeconds = (performance.now() - started) / 1000

  // Drain: wait for outstanding acks and broadcasts, up to 10 s.
  const expectedFanout = clients.length - 1
  const drainDeadline = performance.now() + 10_000
  while (performance.now() < drainDeadline) {
    const pending = [...sent.values()].some(
      op =>
        (op.ackMs === undefined && !op.nack) ||
        (op.ackMs !== undefined && op.delivered < expectedFanout),
    )
    if (!pending) break
    await sleep(50)
  }
  measuring = false
  clearInterval(heartbeat)

  /* ── Verify the op log ──────────────────────────────────────────────────── */

  const logged = new Map<string, number[]>()
  let sinceSeq = 0
  for (;;) {
    const page = await must(
      'read op log',
      http<{ ops: Array<{ id: string; seq: number }>; currentSeq: number }>(
        'GET',
        `/api/boards/${boardId}/operations?sinceSeq=${sinceSeq}&limit=5000`,
        { token: owner },
      ),
    )
    for (const op of page.ops) logged.set(op.id, [...(logged.get(op.id) ?? []), op.seq])
    if (page.ops.length === 0) break
    sinceSeq = page.ops[page.ops.length - 1]!.seq
    if (sinceSeq >= page.currentSeq) break
  }

  for (const client of clients) client.close()

  const all = [...sent.entries()]
  const acked = all.filter(([, op]) => op.ackMs !== undefined)
  const unacked = all.filter(([, op]) => op.ackMs === undefined && !op.nack)
  const missing = acked.filter(([id]) => !logged.has(id))
  const duplicated = acked.filter(([id]) => (logged.get(id)?.length ?? 0) > 1)
  const seqMismatch = acked.filter(
    ([id, op]) => logged.has(id) && logged.get(id)![0] !== op.ackedSeq,
  )
  const undelivered = acked.reduce(
    (sum, [, op]) => sum + Math.max(0, expectedFanout - op.delivered),
    0,
  )

  const ackP95 = percentile(ackLatencies, 95)
  console.log('')
  console.log(
    `Sent        ${all.length} ops in ${sendSeconds.toFixed(1)} s (${(all.length / sendSeconds).toFixed(1)} ops/s)${sendsRefused ? `, ${sendsRefused} not sent (socket closed)` : ''}`,
  )
  console.log(`Acked       ${acked.length}   unacked ${unacked.length}`)
  console.log(
    `Ack         p50 ${ms(percentile(ackLatencies, 50))}   p95 ${ms(ackP95)}   p99 ${ms(percentile(ackLatencies, 99))}   max ${ms(Math.max(...ackLatencies))}`,
  )
  console.log(
    `Fan-out     p50 ${ms(percentile(fanoutLatencies, 50))}   p95 ${ms(percentile(fanoutLatencies, 95))}   p99 ${ms(percentile(fanoutLatencies, 99))}   (${fanoutLatencies.length} deliveries, ${undelivered} missing)`,
  )
  console.log(
    `Nacks       ${nacks.size === 0 ? 'none' : [...nacks].map(([code, n]) => `${code}=${n}`).join(' ')}`,
  )
  console.log(
    `Op log      ${logged.size} ids; acked-but-missing ${missing.length}, duplicated ${duplicated.length}, seq mismatch ${seqMismatch.length}`,
  )
  if (unexpectedCloses.length > 0)
    console.log(`Closes      ${unexpectedCloses.join('; ')}`)

  if (flags.timeline) {
    const perSecond = new Map<number, number[]>()
    for (const [, op] of acked) {
      const second = Math.floor((op.at - started) / 1000)
      perSecond.set(second, [...(perSecond.get(second) ?? []), op.ackMs!])
    }
    console.log('')
    for (const [second, values] of [...perSecond].sort((a, b) => a[0] - b[0])) {
      console.log(
        `  t=${String(second).padStart(3)}s  ack p95 ${ms(percentile(values, 95)).padStart(9)}  max ${ms(Math.max(...values)).padStart(9)}`,
      )
    }
  }

  const failures: string[] = []
  if (!(ackP95 <= ACK_P95_BUDGET_MS))
    failures.push(`ack p95 ${ms(ackP95)} > ${ACK_P95_BUDGET_MS} ms`)
  if (missing.length > 0)
    failures.push(`${missing.length} acked ops missing from the op log`)
  if (duplicated.length > 0)
    failures.push(`${duplicated.length} acked ops duplicated in the op log`)
  if (seqMismatch.length > 0)
    failures.push(`${seqMismatch.length} ops logged at a different seq than acked`)
  if (nacks.size > 0) failures.push('unexpected nacks')
  if (unacked.length > 0) failures.push(`${unacked.length} ops never acked`)
  if (undelivered > 0) failures.push(`${undelivered} broadcasts never delivered`)
  if (unexpectedCloses.length > 0)
    failures.push(`${unexpectedCloses.length} sockets closed unexpectedly`)
  if (sendsRefused > 0) failures.push(`${sendsRefused} ops could not be sent`)

  if (!flags.keep) {
    await http('DELETE', `/api/boards/${boardId}`, { token: owner }).catch(
      () => undefined,
    )
  }

  console.log('')
  if (failures.length > 0) {
    console.log(`FAIL: ${failures.join('; ')}`)
    process.exit(1)
  }
  console.log(
    `PASS: ack p95 ${ms(ackP95)} <= ${ACK_P95_BUDGET_MS} ms, zero committed-op loss`,
  )
  process.exit(0)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
