import { describe, expect, it } from 'vitest'
import { loadEnv } from '../lib/env.js'

const base = {
  DATABASE_URL: 'postgresql://x/y',
  REDIS_URL: 'redis://x',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
}

const smtp = { SMTP_URL: 'smtps://user:pass@smtp.example.com:465' }

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
      loadEnv({ ...base, ...smtp, NODE_ENV: 'production', REGISTER_RATE_LIMIT: '11' }),
    ).toThrow(/REGISTER_RATE_LIMIT/)
  })
})

describe('REST_OPS_RATE_LIMIT — finding 4', () => {
  it('defaults to the socket budget, and production refuses a raised one', () => {
    expect(loadEnv(base).REST_OPS_RATE_LIMIT).toBe(100)
    expect(() =>
      loadEnv({ ...base, ...smtp, NODE_ENV: 'production', REST_OPS_RATE_LIMIT: '1000' }),
    ).toThrow(/REST_OPS_RATE_LIMIT/)
  })
})

describe('SMTP_URL in production — finding 15', () => {
  it('refuses to boot production without SMTP, which would log reset tokens', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(/SMTP_URL/)
    expect(loadEnv({ ...base, ...smtp, NODE_ENV: 'production' }).SMTP_URL).toBe(
      smtp.SMTP_URL,
    )
  })

  it('development still boots without it and logs instead', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'development' })).not.toThrow()
  })
})
