import { RATE_LIMIT_OPS_PER_SEC } from '@coboard/shared'
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
-- Expire well after a full refill, so an idle session's key does not linger.
redis.call('PEXPIRE', key, 60000)
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
    )
    return allowed === 1
  } catch (error) {
    logger.warn({ err: error, key }, 'rate limiter unavailable — failing open')
    return true
  }
}
