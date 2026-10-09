import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('emails an unregistered address, and adds them once they sign up AND verify it (D-22)', async () => {
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
    // D-22: signing up with the address proves nothing; nothing is claimed yet.
    expect(
      await prisma.boardMember.findFirst({ where: { boardId, userId: newcomer.userId } }),
    ).toBeNull()
    await vi.waitFor(() => expect(mailer.verifications).toHaveLength(1))
    const token = new URL(mailer.verifications[0]!.verifyUrl).searchParams.get('token')
    expect(
      (await request(app).post('/api/auth/verify-email').send({ token })).status,
    ).toBe(200)

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
  it("moves the guest's seat to the new account, keeping the guest's VIEWER role (D-23)", async () => {
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
    // A viewer-link guest stays a viewer: signing up is not a promotion.
    expect(res.body).toEqual({ role: 'VIEWER' })
    expect(
      (await prisma.boardMember.findFirst({ where: { boardId, userId: marcus.userId } }))
        ?.role,
    ).toBe('VIEWER')
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

  it('carries the higher of the guest role and an existing membership, never lowering (D-23)', async () => {
    const owner = await signUp()
    const boardId = await createBoard(owner)
    const claim = async (
      guestRole: 'EDITOR' | 'VIEWER',
      existing?: 'EDITOR' | 'VIEWER',
    ) => {
      const user = await signUp('Marcus Feld')
      if (existing) {
        await prisma.boardMember.create({
          data: { boardId, userId: user.userId, role: existing },
        })
      }
      const guestId = randomUUID()
      await prisma.boardMember.create({
        data: { boardId, guestId, guestName: 'Marcus', role: guestRole },
      })
      const res = await request(app)
        .post(`/api/boards/${boardId}/members/claim-guest`)
        .set(auth(user))
        .send({ guestId })
      return res.body.role as string
    }
    expect(await claim('EDITOR')).toBe('EDITOR')
    expect(await claim('VIEWER', 'EDITOR')).toBe('EDITOR')
    expect(await claim('EDITOR', 'VIEWER')).toBe('EDITOR')
    expect(await claim('VIEWER', 'VIEWER')).toBe('VIEWER')
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

describe('the idle-guest sweep — FLOWS §10.3', () => {
  const DAY = 24 * 60 * 60 * 1000

  async function addGuest(boardId: string, lastSeenAt: Date): Promise<string> {
    const guestId = randomUUID()
    await prisma.boardMember.create({
      data: { boardId, guestId, guestName: 'Dana', role: 'VIEWER', lastSeenAt },
    })
    return guestId
  }

  const guestsOn = (boardId: string) =>
    prisma.boardMember.count({ where: { boardId, guestId: { not: null } } })

  it('drops guests once the board has been idle 24 h, and keeps everyone else', async () => {
    const { memberService } = await import('../services/MemberService.js')
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const now = Date.now()
    await prisma.board.update({
      where: { id: boardId },
      data: { lastActivityAt: new Date(now - 2 * DAY) },
    })
    await addGuest(boardId, new Date(now - 2 * DAY))

    expect(await memberService.sweepIdleGuests(async () => false, now)).toBeGreaterThan(0)
    expect(await guestsOn(boardId)).toBe(0)
    // The owner row is untouched.
    expect(await prisma.boardMember.count({ where: { boardId } })).toBe(1)
  })

  it('keeps guests while the board is not idle: a recent op, a recent guest, or anyone connected', async () => {
    const { memberService } = await import('../services/MemberService.js')
    const priya = await signUp()
    const now = Date.now()

    // A recent op.
    const busy = await createBoard(priya)
    await addGuest(busy, new Date(now - 2 * DAY))

    // A guest who came back an hour ago.
    const revisited = await createBoard(priya)
    await prisma.board.update({
      where: { id: revisited },
      data: { lastActivityAt: new Date(now - 2 * DAY) },
    })
    await addGuest(revisited, new Date(now - 2 * DAY))
    await addGuest(revisited, new Date(now - 60 * 60 * 1000))

    // Someone connected right now.
    const live = await createBoard(priya)
    await prisma.board.update({
      where: { id: live },
      data: { lastActivityAt: new Date(now - 2 * DAY) },
    })
    await addGuest(live, new Date(now - 2 * DAY))

    await memberService.sweepIdleGuests(async boardId => boardId === live, now)
    expect(await guestsOn(busy)).toBe(1)
    expect(await guestsOn(revisited)).toBe(2)
    expect(await guestsOn(live)).toBe(1)
  })
})
