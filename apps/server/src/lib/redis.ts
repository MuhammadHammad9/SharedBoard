import Redis from 'ioredis'
import { env } from './env.js'
import { logger } from './logger.js'

/**
 * Redis — rate limits now, presence and pub/sub from Phase 9 (TRD §15.2).
 *
 * Lazily constructed so that importing anything from this module does not open
 * a socket. Unit tests that never touch a rate limit should not need a Redis
 * to run.
 */
let client: Redis | null = null

export function redis(): Redis {
  client ??= new Redis(env().REDIS_URL, {
    maxRetriesPerRequest: 2,
    // Without this a dropped Redis makes every request hang until the socket
    // timeout rather than failing fast into the degraded path below.
    enableOfflineQueue: false,
    lazyConnect: false,
  })
  client.on('error', err => logger.warn({ err: err.message }, 'redis error'))
  return client
}

/**
 * Resolve once the connection is usable.
 *
 * Needed because `enableOfflineQueue: false` makes a command issued before the
 * socket is up fail immediately instead of waiting. That is the behaviour we
 * want in production — a dead Redis should fail fast, not hang every request
 * behind a socket timeout — but it means anything that must NOT degrade, such
 * as a test clearing counters between cases, has to wait for readiness first.
 */
export async function waitForRedis(timeoutMs = 5_000): Promise<void> {
  const c = redis()
  if (c.status === 'ready') return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Redis not ready in time')),
      timeoutMs,
    )
    const done = () => {
      clearTimeout(timer)
      c.off('ready', done)
      resolve()
    }
    c.once('ready', done)
  })
}

export async function closeRedis(): Promise<void> {
  if (!client) return
  await client.quit().catch(() => undefined)
  client = null
}

/**
 * A fixed-window counter: increment, and set the expiry only on first write.
 *
 * Fixed window rather than a sliding log because the requirement is stated as
 * a fixed window — `FR-AUTH-002` says "5 failed attempts within 15 minutes",
 * and the countdown the login screen shows is the window's remaining TTL. A
 * sliding window has no single expiry to display.
 *
 * Returns the count and the seconds remaining. On a Redis outage it returns
 * `{ count: 0 }`, which means **fail open**: a rate limiter that fails closed
 * turns one dead cache into a total login outage. The trade is deliberate and
 * bounded — bcrypt at cost 12 is itself ~250 ms per attempt, so brute force is
 * slow even unthrottled.
 */
export async function hitCounter(
  key: string,
  windowMs: number,
): Promise<{ count: number; resetSeconds: number }> {
  try {
    const c = redis()
    const [[, count]] = (await c
      .multi()
      .incr(key)
      .expire(key, Math.ceil(windowMs / 1000), 'NX')
      .exec()) as [[Error | null, number], ...unknown[]]

    const ttl = await c.ttl(key)
    return { count, resetSeconds: ttl > 0 ? ttl : Math.ceil(windowMs / 1000) }
  } catch (err) {
    logger.warn({ err: (err as Error).message, key }, 'rate limiter degraded — allowing')
    return { count: 0, resetSeconds: 0 }
  }
}

/** Clear a counter — used when a login succeeds, and by tests. */
export async function clearCounter(key: string): Promise<void> {
  try {
    await redis().del(key)
  } catch {
    // A failed clear only means the user keeps a stale strike. Not worth
    // failing the login that just succeeded.
  }
}
