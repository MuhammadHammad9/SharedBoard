import { describe, expect, it } from 'vitest'
import { loadEnv } from '../lib/env.js'

const base = {
  DATABASE_URL: 'postgresql://x/y',
  REDIS_URL: 'redis://x',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
}

describe('REGISTER_RATE_LIMIT — R-SEC-013', () => {
  it('defaults to 10', () => {
    expect(loadEnv(base).REGISTER_RATE_LIMIT).toBe(10)
  })

  it('may be raised outside production, for the e2e suite', () => {
    expect(
      loadEnv({ ...base, NODE_ENV: 'development', REGISTER_RATE_LIMIT: '1000' })
        .REGISTER_RATE_LIMIT,
    ).toBe(1000)
  })

  it('refuses to boot production with a weakened limit', () => {
    expect(() =>
      loadEnv({ ...base, NODE_ENV: 'production', REGISTER_RATE_LIMIT: '11' }),
    ).toThrow(/REGISTER_RATE_LIMIT/)
  })
})
