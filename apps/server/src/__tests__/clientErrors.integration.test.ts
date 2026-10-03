import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { createApp } from '../http/app.js'
import { closeRedis, redis, waitForRedis } from '../lib/redis.js'
import { prisma } from '../lib/prisma.js'

/** S-21 client error reports — FLOWS §12.4, PRD §9 `client_error`. */

let app: Express

const report = {
  correlationId: '1a2b3c4d',
  message: 'Cannot read properties of undefined',
  component: 'PropertiesPanel',
  source: 'boundary',
}

beforeAll(async () => {
  app = createApp()
  await waitForRedis()
})

beforeEach(async () => {
  const keys = await redis().keys('rl:*')
  if (keys.length > 0) await redis().del(...keys)
})

afterAll(async () => {
  await prisma.$disconnect()
  await closeRedis()
})

describe('POST /api/client-errors', () => {
  it('accepts a report from anyone, signed in or not', async () => {
    const response = await request(app).post('/api/client-errors').send(report)
    expect(response.status).toBe(204)
  })

  it('rejects a malformed report rather than logging garbage', async () => {
    for (const bad of [
      { ...report, correlationId: 'not-hex!' },
      { ...report, message: '' },
      { ...report, message: 'x'.repeat(501) },
      { ...report, source: 'somewhere' },
    ]) {
      expect((await request(app).post('/api/client-errors').send(bad)).status).toBe(422)
    }
  })

  it('is rate limited per address: 30 a minute', async () => {
    for (let i = 0; i < 30; i++) {
      expect((await request(app).post('/api/client-errors').send(report)).status).toBe(
        204,
      )
    }
    expect((await request(app).post('/api/client-errors').send(report)).status).toBe(429)
  })
})
