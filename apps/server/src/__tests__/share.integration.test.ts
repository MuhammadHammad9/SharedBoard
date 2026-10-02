import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import type { BoardObject, ClientOp } from '@coboard/shared'
import { createApp } from '../http/app.js'
import { prisma } from '../lib/prisma.js'
import { closeRedis, redis, waitForRedis } from '../lib/redis.js'
import { roomManager } from '../ws/RoomManager.js'

/**
 * Share links, guests and the access guard — FR-SHARE-002/003, FR-AUTH-006,
 * FLOWS §2.3 STEP 4, §7, §10.2. Phase 12b.
 */

let app: Express
const password = 'correct-horse-1'
let counter = 0

interface Actor {
  token: string
  userId: string
}

async function signUp(displayName = 'Priya Raman'): Promise<Actor> {
  const email = `share${++counter}.${Date.now()}@example.com`
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password, displayName })
  expect(response.status).toBe(201)
  const user = await prisma.user.findUniqueOrThrow({
    where: { emailLower: email.toLowerCase() },
  })
  return { token: response.body.accessToken as string, userId: user.id }
}

const auth = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` })
const asGuest = (guestId: string) => ({ 'x-coboard-guest': guestId })

async function createBoard(actor: Actor, name = 'Q3 Retrospective'): Promise<string> {
  const response = await request(app).post('/api/boards').set(auth(actor)).send({ name })
  expect(response.status).toBe(201)
  return response.body.board.id as string
}

async function enableLink(
  owner: Actor,
  boardId: string,
  role: 'EDITOR' | 'VIEWER' = 'EDITOR',
) {
  const response = await request(app)
    .put(`/api/boards/${boardId}/share-link`)
    .set(auth(owner))
    .send({ role })
  expect(response.status).toBe(200)
  return response.body.link.token as string
}

async function join(token: string, name = 'Marcus', guestId = randomUUID()) {
  const response = await request(app)
    .post(`/api/share/${token}/join`)
    .send({ guestId, name })
  return { response, guestId }
}

function stickyOp(): ClientOp {
  const id = randomUUID()
  return {
    id: randomUUID(),
    type: 'CREATE',
    objectId: id,
    payload: {
      id,
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
      text: '',
      color: '#FEF08A',
      fontSize: 16,
      textAlign: 'left',
    } as BoardObject,
  } as ClientOp
}

beforeAll(async () => {
  app = createApp()
  await waitForRedis()
})

beforeEach(async () => {
  await prisma.user.deleteMany({})
  const keys = [...(await redis().keys('rl:*')), ...(await redis().keys('perm:*'))]
  if (keys.length > 0) await redis().del(...keys)
})

afterAll(async () => {
  await prisma.$disconnect()
  await closeRedis()
})

describe('the share link — owner only', () => {
  it('starts off, turns on with a 256-bit token, changes role in place, and turns off', async () => {
    const owner = await signUp()
    const boardId = await createBoard(owner)

    const none = await request(app)
      .get(`/api/boards/${boardId}/share-link`)
      .set(auth(owner))
    expect(none.body.link).toBeNull()

    const token = await enableLink(owner, boardId, 'EDITOR')
    // 32 bytes, base64url — R-SEC-009.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const viewer = await request(app)
      .put(`/api/boards/${boardId}/share-link`)
      .set(auth(owner))
      .send({ role: 'VIEWER' })
    expect(viewer.body.link).toMatchObject({
      token,
      role: 'VIEWER',
      url: `/join/${token}`,
    })

    const off = await request(app)
      .delete(`/api/boards/${boardId}/share-link`)
      .set(auth(owner))
    expect(off.body.link).toBeNull()
  })

  it('never issues the same token twice', async () => {
    const owner = await signUp()
    const tokens = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const boardId = await createBoard(owner)
      tokens.add(await enableLink(owner, boardId))
    }
    expect(tokens.size).toBe(5)
  })

  it('refuses an editor (403), a stranger (404) and a guest (401)', async () => {
    const owner = await signUp()
    const editor = await signUp('Marcus Feld')
    const stranger = await signUp('Dana Ruiz')
    const boardId = await createBoard(owner)
    await prisma.boardMember.create({
      data: { boardId, userId: editor.userId, role: 'EDITOR' },
    })
    const token = await enableLink(owner, boardId)
    const { guestId } = await join(token)

    const put = (h: Record<string, string>) =>
      request(app)
        .put(`/api/boards/${boardId}/share-link`)
        .set(h)
        .send({ role: 'VIEWER' })
    expect((await put(auth(editor))).status).toBe(403)
    expect((await put(auth(stranger))).status).toBe(404)
    expect((await put(asGuest(guestId))).status).toBe(401)
  })
})

describe('the public join card — GET /share/:token', () => {
  it('shows the board, its owner and the link role for a live link', async () => {
    const owner = await signUp('Priya Raman')
    const boardId = await createBoard(owner, 'Q3 Retrospective')
    const token = await enableLink(owner, boardId, 'VIEWER')

    const response = await request(app).get(`/api/share/${token}`)
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      boardId,
      boardName: 'Q3 Retrospective',
      ownerName: 'Priya Raman',
      role: 'VIEWER',
      activeCount: 0,
      present: [],
    })
  })

  it('answers each dead token the way FLOWS §7.3 says', async () => {
    const owner = await signUp()
    const boardId = await createBoard(owner)
    const token = await enableLink(owner, boardId)

    const garbage = await request(app).get('/api/share/not-a-token')
    expect(garbage.status).toBe(404)
    expect(garbage.body.error.details).toEqual({ reason: 'invalid' })

    const unknown = await request(app).get(`/api/share/${'A'.repeat(43)}`)
    expect(unknown.status).toBe(404)

    await request(app).delete(`/api/boards/${boardId}/share-link`).set(auth(owner))
    const revoked = await request(app).get(`/api/share/${token}`)
    expect(revoked.status).toBe(410)
    expect(revoked.body.error.details).toEqual({ reason: 'revoked' })

    await request(app).delete(`/api/boards/${boardId}`).set(auth(owner))
    const deleted = await request(app).get(`/api/share/${token}`)
    expect(deleted.status).toBe(410)
    expect(deleted.body.error.details).toEqual({ reason: 'deleted' })
  })
})

describe('joining as a guest — POST /share/:token/join', () => {
  it("creates a guest member at the link's role and returns the board", async () => {
    const owner = await signUp()
    const boardId = await createBoard(owner)
    const token = await enableLink(owner, boardId, 'EDITOR')

    const { response, guestId } = await join(token, '  Marcus  ')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ boardId, role: 'EDITOR' })

    const member = await prisma.boardMember.findUniqueOrThrow({
      where: { boardId_guestId: { boardId, guestId } },
    })
    // Trimmed, and attached to the link it came through.
    expect(member).toMatchObject({ guestName: 'Marcus', role: 'EDITOR', userId: null })
    expect(member.shareLinkId).not.toBeNull()

    // The guest can now draw.
    const write = await request(app)
      .post(`/api/boards/${boardId}/operations`)
      .set(asGuest(guestId))
      .send({ ops: [stickyOp()] })
    expect(write.status).toBe(200)
  })

  it('validates the name: required, at most 40 characters', async () => {
    const owner = await signUp()
    const boardId = await createBoard(owner)
    const token = await enableLink(owner, boardId)

    expect((await join(token, '   ')).response.status).toBe(422)
    expect((await join(token, 'x'.repeat(41))).response.status).toBe(422)
    expect((await join(token, 'x'.repeat(40))).response.status).toBe(200)
  })

  it('is idempotent for a returning guest, updating only the name', async () => {
    const owner = await signUp()
    const boardId = await createBoard(owner)
    const token = await enableLink(owner, boardId)
    const guestId = randomUUID()

    await join(token, 'Marcus', guestId)
    await join(token, 'Marcus L.', guestId)
    const members = await prisma.boardMember.findMany({ where: { boardId, guestId } })
    expect(members).toHaveLength(1)
    expect(members[0]!.guestName).toBe('Marcus L.')
  })

  it('refuses with board_full when the room is at capacity', async () => {
    const owner = await signUp()
    const boardId = await createBoard(owner)
    const token = await enableLink(owner, boardId)
    const spy = vi.spyOn(roomManager, 'isFull').mockReturnValue(true)
    try {
      const { response } = await join(token)
      expect(response.status).toBe(403)
      expect(response.body.error.details).toEqual({ reason: 'board_full' })
      expect(
        await prisma.boardMember.count({ where: { boardId, guestId: { not: null } } }),
      ).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })

  it('refuses a dead link', async () => {
    const owner = await signUp()
    const boardId = await createBoard(owner)
    const token = await enableLink(owner, boardId)
    await request(app).delete(`/api/boards/${boardId}/share-link`).set(auth(owner))
    expect((await join(token)).response.status).toBe(410)
  })
})

describe('revoking — FR-SHARE-003', () => {
  it('cuts off guests at once: no snapshot, no ticket, no writes', async () => {
    const owner = await signUp()
    const boardId = await createBoard(owner)
    const token = await enableLink(owner, boardId)
    const { guestId } = await join(token)

    // Warm the role cache, so the test proves invalidation rather than a miss.
    expect(
      (await request(app).get(`/api/boards/${boardId}/snapshot`).set(asGuest(guestId)))
        .status,
    ).toBe(200)

    await request(app).delete(`/api/boards/${boardId}/share-link`).set(auth(owner))

    const g = asGuest(guestId)
    expect(
      (await request(app).get(`/api/boards/${boardId}/snapshot`).set(g)).status,
    ).toBe(404)
    expect(
      (await request(app).post('/api/ws/ticket').set(g).send({ boardId })).status,
    ).toBe(404)
    const write = await request(app)
      .post(`/api/boards/${boardId}/operations`)
      .set(g)
      .send({ ops: [stickyOp()] })
    expect(write.status).toBe(403)
  })

  it('reset: the old link dies, the new one works, old guests are out', async () => {
    const owner = await signUp()
    const boardId = await createBoard(owner)
    const oldToken = await enableLink(owner, boardId, 'VIEWER')
    const { guestId } = await join(oldToken)

    const reset = await request(app)
      .post(`/api/boards/${boardId}/share-link/reset`)
      .set(auth(owner))
    const newToken = reset.body.link.token as string
    expect(newToken).not.toBe(oldToken)
    expect(reset.body.link.role).toBe('VIEWER')

    expect((await request(app).get(`/api/share/${oldToken}`)).status).toBe(410)
    expect((await request(app).get(`/api/share/${newToken}`)).status).toBe(200)
    expect(
      (await request(app).get(`/api/boards/${boardId}/snapshot`).set(asGuest(guestId)))
        .status,
    ).toBe(404)
  })

  it("changing the link to view-only downgrades its guests' writes immediately", async () => {
    const owner = await signUp()
    const boardId = await createBoard(owner)
    const token = await enableLink(owner, boardId, 'EDITOR')
    const { guestId } = await join(token)
    const write = () =>
      request(app)
        .post(`/api/boards/${boardId}/operations`)
        .set(asGuest(guestId))
        .send({ ops: [stickyOp()] })

    expect((await write()).status).toBe(200)
    await request(app)
      .put(`/api/boards/${boardId}/share-link`)
      .set(auth(owner))
      .send({ role: 'VIEWER' })
    expect((await write()).status).toBe(403)
  })
})

describe('GET /boards/:id/access — every STEP 4 branch', () => {
  const access = (
    boardId: string,
    headers: Record<string, string> = {},
    share?: string,
  ) =>
    request(app)
      .get(`/api/boards/${boardId}/access${share ? `?share=${share}` : ''}`)
      .set(headers)

  it('member → 200 with the role', async () => {
    const owner = await signUp()
    const editor = await signUp('Marcus Feld')
    const boardId = await createBoard(owner)
    await prisma.boardMember.create({
      data: { boardId, userId: editor.userId, role: 'EDITOR' },
    })

    expect((await access(boardId, auth(owner))).body).toEqual({ role: 'OWNER' })
    expect((await access(boardId, auth(editor))).body).toEqual({ role: 'EDITOR' })
  })

  it('guest member → 200 with the role', async () => {
    const owner = await signUp()
    const boardId = await createBoard(owner)
    const token = await enableLink(owner, boardId, 'VIEWER')
    const { guestId } = await join(token)
    expect((await access(boardId, asGuest(guestId))).body).toEqual({ role: 'VIEWER' })
  })

  it('anonymous with a live link → joinable, requires a name', async () => {
    const owner = await signUp()
    const boardId = await createBoard(owner)
    const token = await enableLink(owner, boardId)
    const response = await access(boardId, {}, token)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ role: 'none', joinable: true, requiresName: true })
  })

  it('signed-in non-member with a live link → becomes a member at the link role', async () => {
    const owner = await signUp()
    const marcus = await signUp('Marcus Feld')
    const boardId = await createBoard(owner)
    const token = await enableLink(owner, boardId, 'VIEWER')
    const response = await access(boardId, auth(marcus), token)
    expect(response.body).toEqual({ role: 'VIEWER' })
    expect(
      await prisma.boardMember.count({ where: { boardId, userId: marcus.userId } }),
    ).toBe(1)
  })

  it('revoked link → 403 link_revoked; no link → 403 no_access', async () => {
    const owner = await signUp()
    const boardId = await createBoard(owner)
    const token = await enableLink(owner, boardId)
    await request(app).delete(`/api/boards/${boardId}/share-link`).set(auth(owner))

    const revoked = await access(boardId, {}, token)
    expect(revoked.status).toBe(403)
    expect(revoked.body.error.details).toEqual({ reason: 'link_revoked' })

    const none = await access(boardId, {})
    expect(none.status).toBe(403)
    expect(none.body.error.details).toEqual({ reason: 'no_access' })
  })

  it("another board's link grants nothing here", async () => {
    const owner = await signUp()
    const boardA = await createBoard(owner)
    const boardB = await createBoard(owner)
    const tokenA = await enableLink(owner, boardA)
    const response = await access(boardB, {}, tokenA)
    expect(response.status).toBe(403)
    expect(response.body.error.details).toEqual({ reason: 'no_access' })
  })

  it('deleted → 410 deleted; nonexistent → 404; never the board name', async () => {
    const owner = await signUp()
    const boardId = await createBoard(owner, 'Secret acquisition')
    await request(app).delete(`/api/boards/${boardId}`).set(auth(owner))

    const deleted = await access(boardId, auth(owner))
    expect(deleted.status).toBe(410)
    expect(deleted.body.error.details).toEqual({ reason: 'deleted' })
    expect(JSON.stringify(deleted.body)).not.toContain('Secret')

    expect((await access(randomUUID(), auth(owner))).status).toBe(404)
  })
})
