import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { createApp } from '../http/app.js'
import { prisma } from '../lib/prisma.js'
import { closeRedis, redis, waitForRedis } from '../lib/redis.js'
import { LoggingMailer, setMailer } from '../lib/mailer.js'

/**
 * Members and invites — TRD §4.3, FLOWS §10.2–10.3, FR-SHARE-001/004.
 * Phase 12c. The live pushes are tested over a real socket in
 * socket.integration.test.ts.
 */

let app: Express
let mailer: LoggingMailer
const password = 'correct-horse-1'
let counter = 0

interface Actor {
  token: string
  userId: string
  email: string
}

const freshEmail = () => `mem${++counter}.${Date.now()}@example.com`

async function signUp(displayName = 'Priya Raman', email = freshEmail()): Promise<Actor> {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password, displayName })
  expect(response.status).toBe(201)
  const user = await prisma.user.findUniqueOrThrow({
    where: { emailLower: email.toLowerCase() },
  })
  return { token: response.body.accessToken as string, userId: user.id, email }
}

const auth = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` })

async function createBoard(actor: Actor, name = 'Q3 Retrospective'): Promise<string> {
  const response = await request(app).post('/api/boards').set(auth(actor)).send({ name })
  expect(response.status).toBe(201)
  return response.body.board.id as string
}

async function memberId(boardId: string, userId: string): Promise<string> {
  return (await prisma.boardMember.findFirstOrThrow({ where: { boardId, userId } })).id
}

beforeAll(async () => {
  app = createApp()
  await waitForRedis()
})

beforeEach(async () => {
  await prisma.user.deleteMany({})
  const keys = [...(await redis().keys('rl:*')), ...(await redis().keys('perm:*'))]
  if (keys.length > 0) await redis().del(...keys)
  mailer = new LoggingMailer()
  setMailer(mailer)
})

afterAll(async () => {
  setMailer(null)
  await prisma.$disconnect()
  await closeRedis()
})

describe('GET /members', () => {
  it('lists the owner first, users with email, guests by name only — never the guest id', async () => {
    const owner = await signUp('Priya Raman')
    const editor = await signUp('Marcus Feld')
    const boardId = await createBoard(owner)
    await prisma.boardMember.create({
      data: { boardId, userId: editor.userId, role: 'EDITOR' },
    })
    const guestId = randomUUID()
    await prisma.boardMember.create({
      data: { boardId, guestId, guestName: 'Dana', role: 'VIEWER' },
    })

    const res = await request(app).get(`/api/boards/${boardId}/members`).set(auth(editor))
    expect(res.status).toBe(200)
    expect(res.body.members.map((m: { name: string }) => m.name)).toEqual([
      'Priya Raman',
      'Marcus Feld',
      'Dana',
    ])
    expect(res.body.members[0]).toMatchObject({ isOwner: true, role: 'OWNER' })
    expect(res.body.members[2]).toMatchObject({
      kind: 'guest',
      email: null,
      role: 'VIEWER',
    })
    // D-1: the guest id is a credential.
    expect(JSON.stringify(res.body)).not.toContain(guestId)
  })

  it('is for signed-in members only: guest 401, stranger 404', async () => {
    const owner = await signUp()
    const stranger = await signUp('Dana Ruiz')
    const boardId = await createBoard(owner)
    const guestId = randomUUID()
    await prisma.boardMember.create({
      data: { boardId, guestId, guestName: 'G', role: 'EDITOR' },
    })

    expect(
      (
        await request(app)
          .get(`/api/boards/${boardId}/members`)
          .set({ 'x-coboard-guest': guestId })
      ).status,
    ).toBe(401)
    expect(
      (await request(app).get(`/api/boards/${boardId}/members`).set(auth(stranger)))
        .status,
    ).toBe(404)
  })
})

describe('POST /members — invite by email, FR-SHARE-004', () => {
  it('adds a registered address straight away; the board is on their dashboard', async () => {
    const owner = await signUp()
    const marcus = await signUp('Marcus Feld')
    const boardId = await createBoard(owner)

    const res = await request(app)
      .post(`/api/boards/${boardId}/members`)
      .set(auth(owner))
      .send({ emails: [marcus.email.toUpperCase()], role: 'VIEWER' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ added: [marcus.email.toLowerCase()], invited: [] })

    const dashboard = await request(app).get('/api/boards').set(auth(marcus))
    expect(dashboard.body.boards.map((b: { id: string }) => b.id)).toContain(boardId)
    expect(mailer.invites).toHaveLength(0)
  })

  it('emails an unregistered address, and adds them the moment they sign up', async () => {
    const owner = await signUp('Priya Raman')
    const boardId = await createBoard(owner, 'Q3 Retrospective')
    const email = freshEmail()

    const res = await request(app)
      .post(`/api/boards/${boardId}/members`)
      .set(auth(owner))
      .send({ emails: [email], role: 'EDITOR' })
    expect(res.body).toEqual({ added: [], invited: [email] })
    expect(mailer.invites[0]).toMatchObject({
      to: email,
      inviterName: 'Priya Raman',
      boardName: 'Q3 Retrospective',
      role: 'EDITOR',
    })
    expect(mailer.invites[0]!.url).toContain(encodeURIComponent(`/board/${boardId}`))

    const listed = await request(app)
      .get(`/api/boards/${boardId}/members`)
      .set(auth(owner))
    expect(listed.body.invites).toEqual([{ email, role: 'EDITOR' }])

    const newcomer = await signUp('Sam Okafor', email)
    const member = await prisma.boardMember.findFirst({
      where: { boardId, userId: newcomer.userId },
    })
    expect(member?.role).toBe('EDITOR')
    const after = await request(app)
      .get(`/api/boards/${boardId}/members`)
      .set(auth(owner))
    expect(after.body.invites).toEqual([])
  })

  it('rejects the whole batch if any address is invalid, naming it', async () => {
    const owner = await signUp()
    const boardId = await createBoard(owner)
    const res = await request(app)
      .post(`/api/boards/${boardId}/members`)
      .set(auth(owner))
      .send({ emails: ['ok@example.com', 'not-an-email'], role: 'EDITOR' })
    expect(res.status).toBe(422)
    expect(res.body.error.details).toEqual({ invalid: ['not-an-email'] })
    expect(await prisma.boardInvite.count()).toBe(0)
  })

  it('never demotes an existing member — least of all the owner inviting themselves', async () => {
    const owner = await signUp()
    const boardId = await createBoard(owner)
    await request(app)
      .post(`/api/boards/${boardId}/members`)
      .set(auth(owner))
      .send({ emails: [owner.email], role: 'VIEWER' })
    const row = await prisma.boardMember.findFirstOrThrow({
      where: { boardId, userId: owner.userId },
    })
    expect(row.role).toBe('OWNER')
  })

  it('is owner-only', async () => {
    const owner = await signUp()
    const editor = await signUp('Marcus Feld')
    const boardId = await createBoard(owner)
    await prisma.boardMember.create({
      data: { boardId, userId: editor.userId, role: 'EDITOR' },
    })
    const res = await request(app)
      .post(`/api/boards/${boardId}/members`)
      .set(auth(editor))
      .send({ emails: ['x@example.com'], role: 'EDITOR' })
    expect(res.status).toBe(403)
  })
})

describe('PATCH / DELETE /members/:memberId', () => {
  it('changes a role; refuses the owner row, OWNER as a role, and non-owners', async () => {
    const owner = await signUp()
    const editor = await signUp('Marcus Feld')
    const boardId = await createBoard(owner)
    await prisma.boardMember.create({
      data: { boardId, userId: editor.userId, role: 'EDITOR' },
    })
    const editorRow = await memberId(boardId, editor.userId)
    const ownerRow = await memberId(boardId, owner.userId)
    const patch = (who: Actor, id: string, role: string) =>
      request(app)
        .patch(`/api/boards/${boardId}/members/${id}`)
        .set(auth(who))
        .send({ role })

    expect((await patch(owner, editorRow, 'VIEWER')).status).toBe(200)
    expect((await patch(owner, ownerRow, 'VIEWER')).status).toBe(403)
    expect((await patch(owner, editorRow, 'OWNER')).status).toBe(422)
    expect((await patch(editor, editorRow, 'EDITOR')).status).toBe(403)

    const row = await prisma.boardMember.findUniqueOrThrow({ where: { id: editorRow } })
    expect(row.role).toBe('VIEWER')
  })

  it('removes a member, never the owner, and only from the board named in the URL', async () => {
    const owner = await signUp()
    const editor = await signUp('Marcus Feld')
    const boardId = await createBoard(owner)
    const otherBoard = await createBoard(owner)
    await prisma.boardMember.create({
      data: { boardId, userId: editor.userId, role: 'EDITOR' },
    })
    const editorRow = await memberId(boardId, editor.userId)
    const ownerRow = await memberId(boardId, owner.userId)

    // A member id from another board must not reach across.
    expect(
      (
        await request(app)
          .delete(`/api/boards/${otherBoard}/members/${editorRow}`)
          .set(auth(owner))
      ).status,
    ).toBe(404)
    expect(
      (
        await request(app)
          .delete(`/api/boards/${boardId}/members/${ownerRow}`)
          .set(auth(owner))
      ).status,
    ).toBe(403)
    expect(
      (
        await request(app)
          .delete(`/api/boards/${boardId}/members/${editorRow}`)
          .set(auth(owner))
      ).status,
    ).toBe(204)
    // And the removal takes effect at once, despite the role cache.
    expect(
      (await request(app).get(`/api/boards/${boardId}/snapshot`).set(auth(editor)))
        .status,
    ).toBe(404)
  })
})

describe('DELETE /members/me — leave', () => {
  it('lets a member or a guest leave; the owner cannot', async () => {
    const owner = await signUp()
    const editor = await signUp('Marcus Feld')
    const boardId = await createBoard(owner)
    await prisma.boardMember.create({
      data: { boardId, userId: editor.userId, role: 'EDITOR' },
    })
    const guestId = randomUUID()
    await prisma.boardMember.create({
      data: { boardId, guestId, guestName: 'G', role: 'EDITOR' },
    })
    const leave = (h: Record<string, string>) =>
      request(app).delete(`/api/boards/${boardId}/members/me`).set(h)

    expect((await leave(auth(editor))).status).toBe(204)
    expect((await leave({ 'x-coboard-guest': guestId })).status).toBe(204)
    expect((await leave(auth(owner))).status).toBe(403)
    expect(await prisma.boardMember.count({ where: { boardId } })).toBe(1)
  })
})

describe('POST /members/claim-guest — guest to account, FLOWS §7.4', () => {
  it("moves the guest's seat to the new account as an Editor", async () => {
    const owner = await signUp()
    const boardId = await createBoard(owner)
    const guestId = randomUUID()
    await prisma.boardMember.create({
      data: { boardId, guestId, guestName: 'Marcus', role: 'VIEWER' },
    })
    const marcus = await signUp('Marcus Feld')

    const res = await request(app)
      .post(`/api/boards/${boardId}/members/claim-guest`)
      .set(auth(marcus))
      .send({ guestId })
    expect(res.body).toEqual({ role: 'EDITOR' })
    expect(await prisma.boardMember.count({ where: { boardId, guestId } })).toBe(0)
    expect(
      (await request(app).get(`/api/boards/${boardId}/snapshot`).set(auth(marcus)))
        .status,
    ).toBe(200)
    // The old guest credential no longer opens anything.
    expect(
      (
        await request(app)
          .get(`/api/boards/${boardId}/snapshot`)
          .set({ 'x-coboard-guest': guestId })
      ).status,
    ).toBe(404)
  })

  it('needs a real guest of this board and a signed-in user', async () => {
    const owner = await signUp()
    const boardId = await createBoard(owner)
    const marcus = await signUp('Marcus Feld')
    expect(
      (
        await request(app)
          .post(`/api/boards/${boardId}/members/claim-guest`)
          .set(auth(marcus))
          .send({ guestId: randomUUID() })
      ).status,
    ).toBe(404)
    const guestId = randomUUID()
    await prisma.boardMember.create({
      data: { boardId, guestId, guestName: 'G', role: 'EDITOR' },
    })
    expect(
      (
        await request(app)
          .post(`/api/boards/${boardId}/members/claim-guest`)
          .set({ 'x-coboard-guest': guestId })
          .send({ guestId })
      ).status,
    ).toBe(401)
  })
})
