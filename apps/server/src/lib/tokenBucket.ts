import { RATE_LIMIT_OPS_PER_SEC, RATE_LIMIT_UPLOADS_PER_HOUR } from '@coboard/shared'
import { redis } from './redis.js'
import { logger } from './logger.js'

/**
 * A token bucket in Redis — R-SEC-013, TRD §5.4 step 3.
 *
 * A bucket rather than a fixed window, because ops are bursty by nature: a
 * paste of forty objects is one user action and must not be refused, while a
 * script sending forty per second forever must be. A window counter cannot
 * tell those apart; a bucket that refills at a steady rate and holds a second's
 * worth of burst can.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  Evaluated as ONE Lua script, so the read, the refill and the take are   │
 * │  a single atomic operation. Doing it as three round trips lets two       │
 * │  concurrent messages both read the same token count and both spend it,   │
 * │  which is the same class of bug as `SELECT MAX(seq)` and just as easy to │
 * │  write by accident.                                                      │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * FAIL-OPEN. If Redis is unreachable the op is allowed through. A rate limiter
 * that becomes a total outage when its own dependency blips has traded a small
 * abuse risk for a large availability one — and every op still passes
 * authorization and validation, which are the checks that actually protect the
 * data.
 */

const SCRIPT = `
local key = KEYS[1]
local rate = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local bucket = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(bucket[1])
local ts = tonumber(bucket[2])

if tokens == nil then
  tokens = capacity
  ts = now
end

-- Refill for the elapsed time, capped at the bucket's capacity.
local elapsed = math.max(0, now - ts) / 1000.0
tokens = math.min(capacity, tokens + elapsed * rate)

local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
-- Expire once a full refill has certainly happened, so an idle key does not
-- linger. Never sooner: an expired key reads as a FULL bucket, so expiring a
-- 20-per-hour bucket after a minute would hand back all 20 tokens.
redis.call('PEXPIRE', key, ttl)
return allowed
`

export interface Bucket {
  /** Tokens added per second. */
  rate: number
  /** Maximum tokens held — the burst allowance. */
  capacity: number
}

export const OPS_BUCKET: Bucket = {
  rate: RATE_LIMIT_OPS_PER_SEC,
  capacity: RATE_LIMIT_OPS_PER_SEC,
}

/** 20 uploads an hour per user — PRD §7.4, R-SEC-013. */
export const UPLOADS_BUCKET: Bucket = {
  rate: RATE_LIMIT_UPLOADS_PER_HOUR / 3_600,
  capacity: RATE_LIMIT_UPLOADS_PER_HOUR,
}

/** Time for an empty bucket to refill completely, plus a margin; at least 60 s. */
const ttlFor = (bucket: Bucket): number =>
  Math.max(60_000, Math.ceil((bucket.capacity / bucket.rate) * 1_000) + 60_000)

export async function consume(
  key: string,
  cost = 1,
  bucket: Bucket = OPS_BUCKET,
): Promise<boolean> {
  try {
    const allowed = await redis().eval(
      SCRIPT,
      1,
      `rl:bucket:${key}`,
      String(bucket.rate),
      String(bucket.capacity),
      String(Date.now()),
      String(cost),
      String(ttlFor(bucket)),
    )
    return allowed === 1
  } catch (error) {
    logger.warn({ err: error, key }, 'rate limiter unavailable — failing open')
    return true
  }
}
