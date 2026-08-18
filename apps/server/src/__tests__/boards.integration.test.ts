import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import {
  ERROR_CODES,
  MAX_OBJECTS_PER_BOARD,
  SNAPSHOT_INTERVAL_OPS,
  SNAPSHOT_RETENTION,
  type BoardObject,
  type ClientOp,
} from '@coboard/shared'
import { createApp } from '../http/app.js'
import { prisma } from '../lib/prisma.js'
import { closeRedis, redis, waitForRedis } from '../lib/redis.js'
import { BOARDS_PAGE_SIZE } from '../services/BoardService.js'
import { OpService } from '../services/OpService.js'
import { SnapshotService } from '../services/SnapshotService.js'

/**
 * Boards, the op log and snapshots — FR-BOARD-001…007, FR-SYNC-008/009,
 * TRD §4.2, §5.4, §3.4.
 *
 * Against a real Postgres, and here that is not a preference. The single most
 * important assertion in this file — that concurrent appends produce a
 * gap-free, duplicate-free sequence — is a claim about row locking inside one
 * database. A mocked client would return whatever the service asked it to and
 * prove nothing at all.
 */

let app: Express

const password = 'correct-horse-1'

let counter = 0
const freshEmail = () => `board${++counter}.${Date.now()}@example.com`

interface Actor {
  email: string
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
  return { email, token: response.body.accessToken as string, userId: user.id }
}

const auth = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` })

async function createBoard(actor: Actor, name?: string): Promise<string> {
  const response = await request(app)
    .post('/api/boards')
    .set(auth(actor))
    .send(name === undefined ? {} : { name })
  expect(response.status).toBe(201)
  return response.body.board.id as string
}

/** A minimal valid sticky, since BoardObjectSchema validates CREATE payloads. */
function sticky(overrides: Partial<BoardObject> = {}): BoardObject {
  return {
    id: randomUUID(),
    type: 'sticky',
    x: 0,
    y: 0,
    width: 200,
    height: 200,
    rotation: 0,
    zIndex: 'a000001',
    opacity: 1,
    createdBy: 'test',
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_000_000,
    text: 'What slowed us down?',
    color: '#FEF08A',
    fontSize: 16,
    textAlign: 'left',
    ...overrides,
  } as BoardObject
}

const createOp = (object: BoardObject): ClientOp => ({
  id: randomUUID(),
  type: 'CREATE',
  objectId: object.id,
  payload: object,
})

const updateOp = (objectId: string, payload: Record<string, unknown>): ClientOp => ({
  id: randomUUID(),
  type: 'UPDATE',
  objectId,
  payload,
})

const deleteOp = (objectId: string): ClientOp => ({
  id: randomUUID(),
  type: 'DELETE',
  objectId,
  payload: {},
})

async function appendOps(actor: Actor, boardId: string, ops: ClientOp[]) {
  return request(app).post(`/api/boards/${boardId}/operations`).set(auth(actor)).send({ ops })
}

beforeAll(async () => {
  app = createApp()
  await waitForRedis()
})

beforeEach(async () => {
  // Boards, memberships, ops and snapshots all cascade from the user.
  await prisma.user.deleteMany({})
  // Registration is rate-limited per IP, and every test in this file signs up
  // two or three people from the same address. Without this the suite locks
  // itself out around test twenty.
  const keys = await redis().keys('rl:*')
  if (keys.length > 0) await redis().del(...keys)
})

afterAll(async () => {
  await prisma.user.deleteMany({})
  await prisma.$disconnect()
  await closeRedis()
})

/* ── Creation, listing, renaming — FR-BOARD-001/002/003 ────────────────────── */

describe('POST /api/boards', () => {
  it('creates a board owned by the caller, with a membership row', async () => {
    const priya = await signUp()
    const id = await createBoard(priya, 'Q3 Retrospective — Platform')

    const board = await prisma.board.findUniqueOrThrow({
      where: { id },
      include: { members: true },
    })
    expect(board.ownerId).toBe(priya.userId)
    expect(board.currentSeq).toBe(0)
    // The owner is a member from the moment the board exists, so members,
    // sharing and role changes never have to special-case them.
    expect(board.members).toHaveLength(1)
    expect(board.members[0]).toMatchObject({ userId: priya.userId, role: 'OWNER' })
  })

  it('defaults the name and reports myRole', async () => {
    const priya = await signUp()
    const response = await request(app).post('/api/boards').set(auth(priya)).send({})
    expect(response.body.board).toMatchObject({
      name: 'Untitled board',
      myRole: 'OWNER',
      objectCount: 0,
    })
  })

  it('rejects an anonymous caller with 401', async () => {
    const response = await request(app).post('/api/boards').send({})
    expect(response.status).toBe(401)
    expect(response.body.error.code).toBe(ERROR_CODES.UNAUTHORIZED)
  })

  it('rejects a name over the limit rather than truncating it', async () => {
    const priya = await signUp()
    const response = await request(app)
      .post('/api/boards')
      .set(auth(priya))
      .send({ name: 'x'.repeat(200) })
    // R-SEC-003: reject, never coerce.
    expect(response.status).toBe(422)
  })
})

describe('GET /api/boards', () => {
  it('lists only boards the caller owns or is a member of', async () => {
    const priya = await signUp()
    const marcus = await signUp('Marcus Feld')

    await createBoard(priya, 'Mine')
    await createBoard(marcus, 'Not mine')

    const response = await request(app).get('/api/boards').set(auth(priya))
    expect(response.status).toBe(200)
    expect(response.body.boards.map((b: { name: string }) => b.name)).toEqual(['Mine'])
  })

  it('includes a shared board and reports the caller EDITOR role', async () => {
    const priya = await signUp()
    const marcus = await signUp('Marcus Feld')
    const id = await createBoard(marcus, 'Pricing page — v3')
    await prisma.boardMember.create({
      data: { boardId: id, userId: priya.userId, role: 'EDITOR' },
    })

    const all = await request(app).get('/api/boards').set(auth(priya))
    expect(all.body.boards).toHaveLength(1)
    expect(all.body.boards[0]).toMatchObject({ myRole: 'EDITOR', ownerName: 'Marcus Feld' })

    const owned = await request(app).get('/api/boards?filter=owned').set(auth(priya))
    expect(owned.body.boards).toHaveLength(0)

    const shared = await request(app).get('/api/boards?filter=shared').set(auth(priya))
    expect(shared.body.boards).toHaveLength(1)
  })

  it('excludes trashed boards from the main list', async () => {
    const priya = await signUp()
    const id = await createBoard(priya, 'Offsite agenda')
    await request(app).delete(`/api/boards/${id}`).set(auth(priya))

    const list = await request(app).get('/api/boards').set(auth(priya))
    expect(list.body.boards).toHaveLength(0)

    const trash = await request(app).get('/api/boards/trash').set(auth(priya))
    expect(trash.body.boards).toHaveLength(1)
    expect(trash.body.boards[0].daysUntilPurge).toBe(30)
  })

  it('searches by name, case-insensitively', async () => {
    const priya = await signUp()
    await createBoard(priya, 'Onboarding flow rewrite')
    await createBoard(priya, 'Pricing page')

    const response = await request(app).get('/api/boards?q=ONBOARD').set(auth(priya))
    expect(response.body.boards.map((b: { name: string }) => b.name)).toEqual([
      'Onboarding flow rewrite',
    ])
  })

  it('paginates with a cursor and never repeats or skips a board', async () => {
    const priya = await signUp()
    const total = BOARDS_PAGE_SIZE + 5
    for (let i = 0; i < total; i++) {
      await createBoard(priya, `Board ${String(i).padStart(2, '0')}`)
    }

    const first = await request(app).get('/api/boards?sort=name').set(auth(priya))
    expect(first.body.boards).toHaveLength(BOARDS_PAGE_SIZE)
    expect(first.body.nextCursor).toEqual(expect.any(String))

    const second = await request(app)
      .get(`/api/boards?sort=name&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .set(auth(priya))
    expect(second.body.boards).toHaveLength(5)
    expect(second.body.nextCursor).toBeNull()

    const names = [...first.body.boards, ...second.body.boards].map(
      (b: { name: string }) => b.name,
    )
    expect(new Set(names).size).toBe(total)
  })

  it('falls back to page one for a corrupt cursor instead of erroring', async () => {
    const priya = await signUp()
    await createBoard(priya, 'Only board')
    const response = await request(app)
      .get('/api/boards?cursor=not-a-real-cursor')
      .set(auth(priya))
    expect(response.status).toBe(200)
    expect(response.body.boards).toHaveLength(1)
  })
})

describe('PATCH /api/boards/:id', () => {
  it('renames a board the caller owns', async () => {
    const priya = await signUp()
    const id = await createBoard(priya, 'Untitled board')
    const response = await request(app)
      .patch(`/api/boards/${id}`)
      .set(auth(priya))
      .send({ name: '  Incident 2026-07-14 timeline  ' })

    expect(response.status).toBe(200)
    // The Zod transform trims; the stored value must be the trimmed one.
    expect(response.body.board.name).toBe('Incident 2026-07-14 timeline')
  })

  it('refuses an EDITOR — rename is owner-only', async () => {
    const priya = await signUp()
    const marcus = await signUp('Marcus Feld')
    const id = await createBoard(priya, 'Mine')
    await prisma.boardMember.create({
      data: { boardId: id, userId: marcus.userId, role: 'EDITOR' },
    })

    const response = await request(app)
      .patch(`/api/boards/${id}`)
      .set(auth(marcus))
      .send({ name: 'Hijacked' })
    expect(response.status).toBe(403)
    expect(await prisma.board.findUniqueOrThrow({ where: { id } })).toMatchObject({
      name: 'Mine',
    })
  })
})

/* ── 404 vs 403 — R-SEC-018 ────────────────────────────────────────────────── */

describe('a board the caller has no access to', () => {
  it('answers 404, and never leaks the board name', async () => {
    const priya = await signUp()
    const marcus = await signUp('Marcus Feld')
    const id = await createBoard(marcus, 'Acquisition target shortlist')

    const response = await request(app).get(`/api/boards/${id}`).set(auth(priya))

    // A 403 would confirm the id names a real board, turning the endpoint into
    // an enumeration oracle — and R-SEC-018 forbids the name on that screen.
    expect(response.status).toBe(404)
    expect(JSON.stringify(response.body)).not.toContain('Acquisition')
  })

  it('reports role none from /access without revealing anything else', async () => {
    const priya = await signUp()
    const marcus = await signUp('Marcus Feld')
    const id = await createBoard(marcus, 'Acquisition target shortlist')

    const response = await request(app).get(`/api/boards/${id}/access`).set(auth(priya))
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ role: 'none', joinable: false })
  })

  it('answers 404 for a malformed id rather than a 500 from the driver', async () => {
    const priya = await signUp()
    const response = await request(app).get('/api/boards/not-a-uuid').set(auth(priya))
    expect(response.status).toBe(404)
  })
})

/* ── The op log — TRD §5.4 ─────────────────────────────────────────────────── */

describe('POST /api/boards/:id/operations', () => {
  it('assigns sequence numbers from 1 and advances currentSeq', async () => {
    const priya = await signUp()
    const id = await createBoard(priya)

    const first = await appendOps(priya, id, [createOp(sticky()), createOp(sticky())])
    expect(first.status).toBe(200)
    expect(first.body.applied.map((o: { seq: number }) => o.seq)).toEqual([1, 2])
    expect(first.body.currentSeq).toBe(2)

    const second = await appendOps(priya, id, [createOp(sticky())])
    expect(second.body.applied[0].seq).toBe(3)
  })

  it('is idempotent: a replayed op id is re-acked with its ORIGINAL seq', async () => {
    const priya = await signUp()
    const id = await createBoard(priya)
    const op = createOp(sticky())

    const first = await appendOps(priya, id, [op])
    expect(first.body.applied[0]).toMatchObject({ seq: 1, duplicate: false })

    // R-SYNC-014: the client retried after a dropped response. Inserting again
    // would duplicate the object on every screen in the room.
    const replay = await appendOps(priya, id, [op])
    expect(replay.status).toBe(200)
    expect(replay.body.applied[0]).toMatchObject({ seq: 1, duplicate: true })
    expect(replay.body.currentSeq).toBe(1)

    expect(await prisma.operation.count({ where: { boardId: id } })).toBe(1)
  })

  it('re-acks the stored half of a partially-replayed batch and stores the rest', async () => {
    const priya = await signUp()
    const id = await createBoard(priya)
    const seen = createOp(sticky())
    await appendOps(priya, id, [seen])

    const fresh = createOp(sticky())
    const mixed = await appendOps(priya, id, [seen, fresh])
    expect(mixed.body.applied).toEqual([
      expect.objectContaining({ id: seen.id, seq: 1, duplicate: true }),
      expect.objectContaining({ id: fresh.id, seq: 2, duplicate: false }),
    ])
  })

  it('rejects a VIEWER with 403 and writes NOTHING — AT-20', async () => {
    const priya = await signUp()
    const marcus = await signUp('Marcus Feld')
    const id = await createBoard(priya)
    await prisma.boardMember.create({
      data: { boardId: id, userId: marcus.userId, role: 'VIEWER' },
    })

    const response = await appendOps(marcus, id, [createOp(sticky())])

    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe(ERROR_CODES.FORBIDDEN)
    // The half that matters: authorization runs BEFORE persistence, so a
    // forged op leaves no trace and does not advance the sequence.
    expect(await prisma.operation.count({ where: { boardId: id } })).toBe(0)
    expect(await prisma.board.findUniqueOrThrow({ where: { id } })).toMatchObject({
      currentSeq: 0,
    })
  })

  it('rejects a non-finite coordinate — R-SEC-004', async () => {
    const priya = await signUp()
    const id = await createBoard(priya)

    /*
     * Sent as a RAW body, not through supertest's serialiser.
     *
     * JSON has no Infinity, so `JSON.stringify({ x: Infinity })` emits `null`
     * and the test would pass for the wrong reason. `1e400` is what a hostile
     * client actually puts on the wire, and Express's JSON parser turns it
     * into Infinity before Zod ever sees it — which is exactly the path
     * R-SEC-004 is about. An Infinity in a coordinate blanks the canvas for
     * EVERY user in the room.
     */
    const response = await request(app)
      .post(`/api/boards/${id}/operations`)
      .set(auth(priya))
      .set('content-type', 'application/json')
      .send(
        JSON.stringify({
          ops: [
            {
              id: randomUUID(),
              type: 'CREATE',
              objectId: randomUUID(),
              payload: { ...sticky(), x: 0 },
            },
          ],
        }).replace('"x":0', '"x":1e400'),
      )

    expect(response.status).toBe(422)
    expect(await prisma.operation.count({ where: { boardId: id } })).toBe(0)
  })

  it('keeps objectCount honest across creates and deletes', async () => {
    const priya = await signUp()
    const id = await createBoard(priya)
    const a = sticky()
    const b = sticky()

    await appendOps(priya, id, [createOp(a), createOp(b)])
    expect(await prisma.board.findUniqueOrThrow({ where: { id } })).toMatchObject({
      objectCount: 2,
    })

    await appendOps(priya, id, [deleteOp(a.id)])
    expect(await prisma.board.findUniqueOrThrow({ where: { id } })).toMatchObject({
      objectCount: 1,
    })
  })

  it('refuses to push a board past MAX_OBJECTS_PER_BOARD', async () => {
    const priya = await signUp()
    const id = await createBoard(priya)
    await prisma.board.update({
      where: { id },
      data: { objectCount: MAX_OBJECTS_PER_BOARD },
    })

    const response = await appendOps(priya, id, [createOp(sticky())])
    expect(response.status).toBe(422)
    expect(await prisma.operation.count({ where: { boardId: id } })).toBe(0)
  })

  it('404s for a trashed board rather than accepting ops into the void', async () => {
    const priya = await signUp()
    const id = await createBoard(priya)
    await request(app).delete(`/api/boards/${id}`).set(auth(priya))

    const response = await appendOps(priya, id, [createOp(sticky())])
    expect(response.status).toBe(404)
  })
})

/* ── The one that matters: concurrent sequence assignment — R-SYNC-013 ─────── */

describe('sequence assignment under concurrency', () => {
  it('produces a monotonic, gap-free, duplicate-free sequence', async () => {
    const priya = await signUp()
    const id = await createBoard(priya)

    /*
     * Forty requests fired at once, each carrying one to three ops.
     *
     * This is the test the whole service is shaped around. The naive
     * implementation — SELECT MAX(seq), then INSERT — passes every sequential
     * test and fails here: two requests read the same maximum, both write it,
     * and the board's history has two ops claiming one position. No client can
     * resolve that, so every board diverges silently and permanently.
     *
     * The fix is the `UPDATE board SET currentSeq = currentSeq + n RETURNING`
     * inside the transaction, which takes a row lock for the duration.
     */
    const batches = Array.from({ length: 40 }, (_, i) =>
      Array.from({ length: (i % 3) + 1 }, () => createOp(sticky())),
    )
    const expected = batches.reduce((n, batch) => n + batch.length, 0)

    const responses = await Promise.all(batches.map(ops => appendOps(priya, id, ops)))
    expect(responses.every(r => r.status === 200)).toBe(true)

    const rows = await prisma.operation.findMany({
      where: { boardId: id },
      orderBy: { seq: 'asc' },
      select: { seq: true },
    })

    expect(rows).toHaveLength(expected)
    // Gap-free and duplicate-free: seq n is at index n-1, with no exceptions.
    expect(rows.map(r => r.seq)).toEqual(
      Array.from({ length: expected }, (_, i) => i + 1),
    )
    expect(await prisma.board.findUniqueOrThrow({ where: { id } })).toMatchObject({
      currentSeq: expected,
      objectCount: expected,
    })
  })

  it('keeps each request BATCH contiguous, so a paste is never interleaved', async () => {
    const priya = await signUp()
    const id = await createBoard(priya)

    const batches = Array.from({ length: 12 }, () =>
      Array.from({ length: 5 }, () => createOp(sticky())),
    )
    const responses = await Promise.all(batches.map(ops => appendOps(priya, id, ops)))

    for (const response of responses) {
      const seqs = response.body.applied.map((o: { seq: number }) => o.seq)
      // A five-object paste that landed as 3, 7, 9, 14, 20 would still be
      // gap-free overall, but a client draining ops in order would show the
      // paste appearing in pieces.
      expect(seqs).toEqual([seqs[0], seqs[0] + 1, seqs[0] + 2, seqs[0] + 3, seqs[0] + 4])
    }
  })

  it('does not serialise appends to DIFFERENT boards', async () => {
    const priya = await signUp()
    const [a, b] = [await createBoard(priya, 'A'), await createBoard(priya, 'B')]

    await Promise.all([
      appendOps(priya, a, [createOp(sticky())]),
      appendOps(priya, b, [createOp(sticky())]),
    ])

    // Both start at 1: the lock is per board row, not a global counter.
    for (const id of [a, b]) {
      expect(await prisma.board.findUniqueOrThrow({ where: { id } })).toMatchObject({
        currentSeq: 1,
      })
    }
  })
})

/* ── Load path: materialisation and snapshots — FR-SYNC-009, TRD §3.4 ─────── */

describe('GET /api/boards/:id/snapshot', () => {
  it('folds the log into objects and reports the seq it is current as of', async () => {
    const priya = await signUp()
    const id = await createBoard(priya)
    const note = sticky({ text: 'Ship the guard first' })
    await appendOps(priya, id, [createOp(note)])
    await appendOps(priya, id, [updateOp(note.id, { x: 400 })])

    const response = await request(app).get(`/api/boards/${id}/snapshot`).set(auth(priya))
    expect(response.status).toBe(200)
    expect(response.body.seq).toBe(2)
    expect(response.body.objects).toHaveLength(1)
    expect(response.body.objects[0]).toMatchObject({
      id: note.id,
      x: 400,
      // R-CONV-002: a partial UPDATE merges. If the fold treated the payload
      // as a whole object, the text would be gone.
      text: 'Ship the guard first',
    })
  })

  it('drops an UPDATE for an object that was already deleted — R-CONV-004', async () => {
    const priya = await signUp()
    const id = await createBoard(priya)
    const note = sticky()
    await appendOps(priya, id, [createOp(note)])
    await appendOps(priya, id, [deleteOp(note.id)])
    await appendOps(priya, id, [updateOp(note.id, { x: 999 })])

    const response = await request(app).get(`/api/boards/${id}/snapshot`).set(auth(priya))
    // Delete beats update. A resurrected partial object would be a ghost with
    // no type and no geometry.
    expect(response.body.objects).toHaveLength(0)
  })

  it('lets a VIEWER read state but reports their role', async () => {
    const priya = await signUp()
    const marcus = await signUp('Marcus Feld')
    const id = await createBoard(priya)
    await prisma.boardMember.create({
      data: { boardId: id, userId: marcus.userId, role: 'VIEWER' },
    })
    await appendOps(priya, id, [createOp(sticky())])

    const response = await request(app).get(`/api/boards/${id}/snapshot`).set(auth(marcus))
    expect(response.status).toBe(200)
    expect(response.body.myRole).toBe('VIEWER')
    expect(response.body.objects).toHaveLength(1)
  })
})

describe('GET /api/boards/:id/operations', () => {
  it('returns only ops after the given seq — the reconnect gap fill', async () => {
    const priya = await signUp()
    const id = await createBoard(priya)
    for (let i = 0; i < 5; i++) await appendOps(priya, id, [createOp(sticky())])

    const response = await request(app)
      .get(`/api/boards/${id}/operations?sinceSeq=3`)
      .set(auth(priya))
    expect(response.body.ops.map((o: { seq: number }) => o.seq)).toEqual([4, 5])
    expect(response.body.currentSeq).toBe(5)
  })
})

describe('snapshots', () => {
  const ops = new OpService(prisma)
  const snapshots = new SnapshotService(prisma)

  it('does not snapshot before the interval, and does after it', async () => {
    const priya = await signUp()
    const id = await createBoard(priya)

    await ops.append(id, [createOp(sticky())], { userId: priya.userId })
    expect(await snapshots.maybeSnapshot(id)).toBe(false)

    // Fast-forward the counter rather than appending 500 ops: what is under
    // test is the interval decision, not the append path, which has its own
    // tests above.
    await prisma.board.update({
      where: { id },
      data: { currentSeq: SNAPSHOT_INTERVAL_OPS },
    })
    expect(await snapshots.maybeSnapshot(id)).toBe(true)

    const stored = await prisma.snapshot.findFirstOrThrow({ where: { boardId: id } })
    expect(stored.seq).toBe(SNAPSHOT_INTERVAL_OPS)
    expect((stored.state as { objects: unknown[] }).objects).toHaveLength(1)
  })

  it('materialises identically whether or not a snapshot is used', async () => {
    const priya = await signUp()
    const id = await createBoard(priya)
    const note = sticky({ text: 'Needs a decision by Friday' })
    await ops.append(id, [createOp(note), createOp(sticky())], { userId: priya.userId })
    await ops.append(id, [updateOp(note.id, { x: 88, y: 99 })], { userId: priya.userId })

    const replayed = await snapshots.materialise(id)
    expect(replayed.fromSnapshot).toBe(false)

    await snapshots.snapshotNow(id, 3)
    const fromSnapshot = await snapshots.materialise(id)

    expect(fromSnapshot.fromSnapshot).toBe(true)
    expect(fromSnapshot.replayed).toBe(0)
    /*
     * The convergence claim, at the smallest scale it can be made: a board
     * loaded from a snapshot and a board replayed from op 1 must be the same
     * board. If these two ever disagree, every client that loaded on one side
     * of a snapshot diverges from every client that loaded on the other.
     */
    const key = (m: { objects: { id: string }[] }) =>
      JSON.stringify([...m.objects].sort((x, y) => (x.id < y.id ? -1 : 1)))
    expect(key(fromSnapshot)).toBe(key(replayed))
  })

  it('folds ops that arrive AFTER the snapshot on top of it', async () => {
    const priya = await signUp()
    const id = await createBoard(priya)
    const note = sticky()
    await ops.append(id, [createOp(note)], { userId: priya.userId })
    await snapshots.snapshotNow(id, 1)

    await ops.append(id, [updateOp(note.id, { x: 1234 })], { userId: priya.userId })

    const state = await snapshots.materialise(id)
    expect(state.fromSnapshot).toBe(true)
    expect(state.replayed).toBe(1)
    expect(state.objects[0]).toMatchObject({ x: 1234 })
    expect(state.seq).toBe(2)
  })

  it(`retains ${SNAPSHOT_RETENTION} snapshots and prunes the rest`, async () => {
    const priya = await signUp()
    const id = await createBoard(priya)
    for (let i = 1; i <= 5; i++) {
      await ops.append(id, [createOp(sticky())], { userId: priya.userId })
      await snapshots.snapshotNow(id, i)
    }

    const stored = await prisma.snapshot.findMany({
      where: { boardId: id },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    })
    expect(stored.map(s => s.seq)).toEqual([5, 4, 3])
  })
})

/* ── Trash, restore, permanent delete, duplicate — FR-BOARD-005/006/007 ───── */

describe('trash and restore', () => {
  it('soft-deletes and restores without touching the op log', async () => {
    const priya = await signUp()
    const id = await createBoard(priya, 'Offsite agenda')
    await appendOps(priya, id, [createOp(sticky())])

    await request(app).delete(`/api/boards/${id}`).set(auth(priya)).expect(200)
    expect(await prisma.operation.count({ where: { boardId: id } })).toBe(1)

    await request(app).post(`/api/boards/${id}/restore`).set(auth(priya)).expect(200)
    const state = await request(app).get(`/api/boards/${id}/snapshot`).set(auth(priya))
    // Nothing was destroyed, so restore is one UPDATE and the board comes back
    // whole — which is what makes the toast's Undo trivial.
    expect(state.body.objects).toHaveLength(1)
  })

  it('refuses a non-owner', async () => {
    const priya = await signUp()
    const marcus = await signUp('Marcus Feld')
    const id = await createBoard(priya)
    await prisma.boardMember.create({
      data: { boardId: id, userId: marcus.userId, role: 'EDITOR' },
    })
    await request(app).delete(`/api/boards/${id}`).set(auth(marcus)).expect(403)
  })
})

describe('POST /api/boards/:id/permanent-delete', () => {
  it('requires an exact name match', async () => {
    const priya = await signUp()
    const id = await createBoard(priya, 'Offsite agenda')

    const wrong = await request(app)
      .post(`/api/boards/${id}/permanent-delete`)
      .set(auth(priya))
      .send({ confirmName: 'offsite agenda' })
    expect(wrong.status).toBe(422)
    expect(wrong.body.error.code).toBe(ERROR_CODES.CONFIRMATION_MISMATCH)
    expect(await prisma.board.count({ where: { id } })).toBe(1)

    await request(app)
      .post(`/api/boards/${id}/permanent-delete`)
      .set(auth(priya))
      .send({ confirmName: 'Offsite agenda' })
      .expect(204)
    expect(await prisma.board.count({ where: { id } })).toBe(0)
  })

  it('cascades the ops, snapshots and memberships with the board', async () => {
    const priya = await signUp()
    const id = await createBoard(priya, 'Gone')
    await appendOps(priya, id, [createOp(sticky())])
    await new SnapshotService(prisma).snapshotNow(id, 1)

    await request(app)
      .post(`/api/boards/${id}/permanent-delete`)
      .set(auth(priya))
      .send({ confirmName: 'Gone' })
      .expect(204)

    expect(await prisma.operation.count({ where: { boardId: id } })).toBe(0)
    expect(await prisma.snapshot.count({ where: { boardId: id } })).toBe(0)
    expect(await prisma.boardMember.count({ where: { boardId: id } })).toBe(0)
  })
})

describe('POST /api/boards/:id/duplicate', () => {
  it('copies the content, names it "(copy)", and shares it with nobody', async () => {
    const priya = await signUp()
    const marcus = await signUp('Marcus Feld')
    const id = await createBoard(priya, 'Pricing page — v3')
    await prisma.boardMember.create({
      data: { boardId: id, userId: marcus.userId, role: 'EDITOR' },
    })
    await appendOps(priya, id, [createOp(sticky({ text: 'Blocked on the migration' }))])

    const response = await request(app)
      .post(`/api/boards/${id}/duplicate`)
      .set(auth(priya))
    expect(response.status).toBe(201)
    expect(response.body.board.name).toBe('Pricing page — v3 (copy)')

    const copyId = response.body.board.id as string
    // A copy is a new document, not a fork of an access list: re-sharing it
    // automatically would leak it to people the user may have meant to drop.
    expect(await prisma.boardMember.count({ where: { boardId: copyId } })).toBe(1)

    const state = await request(app).get(`/api/boards/${copyId}/snapshot`).set(auth(priya))
    expect(state.body.objects).toHaveLength(1)
    expect(state.body.objects[0].text).toBe('Blocked on the migration')
    // Fresh ids: two documents must never share an object id.
    expect(state.body.objects[0].id).not.toBe(
      (await prisma.operation.findFirstOrThrow({ where: { boardId: id } })).objectId,
    )
  })

  it('copies the current STATE, not the history', async () => {
    const priya = await signUp()
    const id = await createBoard(priya, 'Churn')
    const keep = sticky()
    const gone = sticky()
    await appendOps(priya, id, [createOp(keep), createOp(gone)])
    await appendOps(priya, id, [updateOp(keep.id, { x: 50 })])
    await appendOps(priya, id, [deleteOp(gone.id)])

    const response = await request(app)
      .post(`/api/boards/${id}/duplicate`)
      .set(auth(priya))
    const copyId = response.body.board.id as string

    // Four source ops, one surviving object, so ONE op in the copy. Replaying
    // the log would have reproduced the deleted object's whole life.
    expect(await prisma.operation.count({ where: { boardId: copyId } })).toBe(1)
    const state = await request(app).get(`/api/boards/${copyId}/snapshot`).set(auth(priya))
    expect(state.body.objects).toHaveLength(1)
    expect(state.body.objects[0]).toMatchObject({ x: 50 })
  })
})
