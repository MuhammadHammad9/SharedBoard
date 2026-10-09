import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import type { BoardObject, ClientOp } from '@coboard/shared'
import { createApp } from '../http/app.js'
import { prisma } from '../lib/prisma.js'
import { closeRedis, redis, waitForRedis } from '../lib/redis.js'
import { permissionService } from '../services/PermissionService.js'

/**
 * Who may do what — FR-SHARE-001, FR-AUTH-006, TRD §11.2, Phase 12a.
 *
 * Guests, the cached role, and the owner-only actions. The socket half of the
 * mid-session demotion lives in socket.integration.test.ts with the other
 * socket tests.
 */

let app: Express
const password = 'correct-horse-1'
let counter = 0

interface Actor {
  token: string
  userId: string
}

async function signUp(displayName = 'Priya Raman'): Promise<Actor> {
  const email = `perm${++counter}.${Date.now()}@example.com`
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

async function createBoard(actor: Actor): Promise<string> {
  const response = await request(app).post('/api/boards').set(auth(actor)).send({})
  expect(response.status).toBe(201)
  return response.body.board.id as string
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

async function addGuest(boardId: string, role: 'EDITOR' | 'VIEWER', name = 'Marcus') {
  const guestId = randomUUID()
  await prisma.boardMember.create({ data: { boardId, guestId, guestName: name, role } })
  return guestId
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

describe('owner-only actions — FR-SHARE-001', () => {
  it('refuses an EDITOR calling the delete-board endpoint directly — AT-24', async () => {
    const owner = await signUp()
    const editor = await signUp('Marcus Feld')
    const boardId = await createBoard(owner)
    await prisma.boardMember.create({
      data: { boardId, userId: editor.userId, role: 'EDITOR' },
    })

    const response = await request(app).delete(`/api/boards/${boardId}`).set(auth(editor))
    expect(response.status).toBe(403)
    const board = await prisma.board.findUniqueOrThrow({ where: { id: boardId } })
    expect(board.deletedAt).toBeNull()
  })

  it('answers a stranger 404, not 403, so ids cannot be probed — R-SEC-018', async () => {
    const owner = await signUp()
    const stranger = await signUp('Dana Ruiz')
    const boardId = await createBoard(owner)
    const response = await request(app)
      .delete(`/api/boards/${boardId}`)
      .set(auth(stranger))
    expect(response.status).toBe(404)
  })
})

describe('guests — FR-AUTH-006', () => {
  it('lets a guest EDITOR read the board and write ops', async () => {
    const owner = await signUp()
    const boardId = await createBoard(owner)
    const guestId = await addGuest(boardId, 'EDITOR')

    const snapshot = await request(app)
      .get(`/api/boards/${boardId}/snapshot`)
      .set(asGuest(guestId))
    expect(snapshot.status).toBe(200)
    expect(snapshot.body.myRole).toBe('EDITOR')

    const write = await request(app)
      .post(`/api/boards/${boardId}/operations`)
      .set(asGuest(guestId))
      .send({ ops: [stickyOp()] })
    expect(write.status).toBe(200)

    // Attributed to the guest, not to anyone's account.
    const stored = await prisma.operation.findFirstOrThrow({ where: { boardId } })
    expect(stored.actorGuest).toBe(guestId)
    expect(stored.actorId).toBeNull()
  })

  it('refuses a guest VIEWER write with 403 and writes nothing — AT-20 over REST', async () => {
    const owner = await signUp()
    const boardId = await createBoard(owner)
    const guestId = await addGuest(boardId, 'VIEWER')

    const write = await request(app)
      .post(`/api/boards/${boardId}/operations`)
      .set(asGuest(guestId))
      .send({ ops: [stickyOp()] })
    expect(write.status).toBe(403)
    expect(await prisma.operation.count({ where: { boardId } })).toBe(0)
  })

  it('gives an unknown guest id nothing — a 404, as for a stranger', async () => {
    const owner = await signUp()
    const boardId = await createBoard(owner)
    const response = await request(app)
      .get(`/api/boards/${boardId}/snapshot`)
      .set(asGuest(randomUUID()))
    expect(response.status).toBe(404)
  })

  it('does not let a guest of one board into another board', async () => {
    const owner = await signUp()
    const boardA = await createBoard(owner)
    const boardB = await createBoard(owner)
    const guestId = await addGuest(boardA, 'EDITOR')
    const response = await request(app)
      .get(`/api/boards/${boardB}/snapshot`)
      .set(asGuest(guestId))
    expect(response.status).toBe(404)
  })

  it('keeps guests out of everything account-only: dashboard, create, rename, delete', async () => {
    const owner = await signUp()
    const boardId = await createBoard(owner)
    const guestId = await addGuest(boardId, 'EDITOR')
    const g = asGuest(guestId)

    expect((await request(app).get('/api/boards').set(g)).status).toBe(401)
    expect((await request(app).post('/api/boards').set(g).send({})).status).toBe(401)
    expect(
      (await request(app).patch(`/api/boards/${boardId}`).set(g).send({ name: 'x' }))
        .status,
    ).toBe(401)
    expect((await request(app).delete(`/api/boards/${boardId}`).set(g)).status).toBe(401)
  })

  it('ignores a malformed guest header rather than treating it as an identity', async () => {
    const owner = await signUp()
    const boardId = await createBoard(owner)
    const response = await request(app)
      .get(`/api/boards/${boardId}/snapshot`)
      .set({ 'x-coboard-guest': "'; drop table users; --" })
    expect(response.status).toBe(401)
  })

  it('issues a socket ticket to a guest member, and not to a stranger', async () => {
    const owner = await signUp()
    const boardId = await createBoard(owner)
    const guestId = await addGuest(boardId, 'VIEWER')

    const ok = await request(app)
      .post('/api/ws/ticket')
      .set(asGuest(guestId))
      .send({ boardId })
    expect(ok.status).toBe(200)
    const no = await request(app)
      .post('/api/ws/ticket')
      .set(asGuest(randomUUID()))
      .send({ boardId })
    expect(no.status).toBe(404)
  })
})

describe('the cached role — TRD §11.2', () => {
  it('serves the cached role until invalidated, then the new one', async () => {
    const owner = await signUp()
    const editor = await signUp('Marcus Feld')
    const boardId = await createBoard(owner)
    await prisma.boardMember.create({
      data: { boardId, userId: editor.userId, role: 'EDITOR' },
    })

    expect(await permissionService.getRole(boardId, editor.userId)).toBe('EDITOR')
    await prisma.boardMember.updateMany({
      where: { boardId, userId: editor.userId },
      data: { role: 'VIEWER' },
    })
    // Still cached — the TTL bounds staleness only when an invalidation is missed.
    expect(await permissionService.getRole(boardId, editor.userId)).toBe('EDITOR')

    await permissionService.invalidate(boardId, editor.userId)
    expect(await permissionService.getRole(boardId, editor.userId)).toBe('VIEWER')
  })

  it('invalidates every identity on the board at once', async () => {
    const owner = await signUp()
    const boardId = await createBoard(owner)
    const guestId = await addGuest(boardId, 'EDITOR')
    expect(await permissionService.getRole(boardId, { kind: 'guest', guestId })).toBe(
      'EDITOR',
    )
    expect(await permissionService.getRole(boardId, owner.userId)).toBe('OWNER')
    expect((await redis().keys(`perm:${boardId}:*`)).length).toBe(2)

    await permissionService.invalidate(boardId)
    expect((await redis().keys(`perm:${boardId}:*`)).length).toBe(0)
  })

  it('reports a deleted board as gone the moment it is trashed', async () => {
    const owner = await signUp()
    const editor = await signUp('Marcus Feld')
    const boardId = await createBoard(owner)
    await prisma.boardMember.create({
      data: { boardId, userId: editor.userId, role: 'EDITOR' },
    })
    expect(await permissionService.getRole(boardId, editor.userId)).toBe('EDITOR')

    await request(app).delete(`/api/boards/${boardId}`).set(auth(owner))
    expect(await permissionService.getRole(boardId, editor.userId)).toBe('gone')
  })
})
