import { availableParallelism } from 'node:os'
import client from 'prom-client'
import { env } from './env.js'
import { prisma } from './prisma.js'
import { redis } from './redis.js'

/**
 * Prometheus metrics — TRD §15.4, Phase 15e.
 *
 * The eight monitored signals, each named for the alert in
 * `infra/prometheus/alerts.yml` that reads it:
 *
 * | Signal                     | Series                                                       |
 * | -------------------------- | ------------------------------------------------------------ |
 * | Error rate                 | `coboard_http_requests_total{route,method,status_class}`     |
 * | Op persist latency p95     | `coboard_op_persist_duration_seconds` (histogram)            |
 * | WS connection failure rate | `coboard_ws_connection_{attempts,failures}_total`            |
 * | Connected sockets          | `coboard_ws_connected_sockets`                               |
 * | Postgres pool utilisation  | `coboard_pg_pool_connections{state}`, `…_max`                |
 * | Redis memory               | `coboard_redis_memory_used_bytes`, `…_maxmemory_bytes`       |
 * | op_rejected rate           | `coboard_ops_{accepted,rejected}_total`                      |
 * | Snapshot job failures      | `coboard_job_failures_total{task}`                           |
 *
 * A dedicated registry rather than prom-client's global one, so nothing a
 * dependency registers leaks into the endpoint, and process defaults (heap,
 * event-loop lag, GC) are added under the same `coboard_` prefix.
 *
 * Counters are per process. With several instances Prometheus scrapes each and
 * the alert expressions `sum` across them.
 */

export const registry = new client.Registry()
client.collectDefaultMetrics({ register: registry, prefix: 'coboard_' })

export const httpRequests = new client.Counter({
  name: 'coboard_http_requests_total',
  help: 'HTTP requests by route pattern, method and status class',
  labelNames: ['route', 'method', 'status_class'] as const,
  registers: [registry],
})

export const opPersistSeconds = new client.Histogram({
  name: 'coboard_op_persist_duration_seconds',
  help: 'Time spent in the op-append transaction (idempotency check, seq claim, insert)',
  // Dense around the 100 ms alert threshold, so the p95 is not interpolated
  // across a 100 ms-wide bucket.
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.25, 0.5, 1, 2.5],
  registers: [registry],
})

export const wsAttempts = new client.Counter({
  name: 'coboard_ws_connection_attempts_total',
  help: 'WebSocket upgrade requests received',
  registers: [registry],
})

export const wsFailures = new client.Counter({
  name: 'coboard_ws_connection_failures_total',
  help: 'WebSocket upgrades refused or failed, by reason',
  labelNames: ['reason'] as const,
  registers: [registry],
})

export const wsConnected = new client.Gauge({
  name: 'coboard_ws_connected_sockets',
  help: 'WebSocket connections currently open on this instance',
  registers: [registry],
})

export const opsAccepted = new client.Counter({
  name: 'coboard_ops_accepted_total',
  help: 'Ops acknowledged (persisted, or re-acked as an idempotent duplicate)',
  labelNames: ['transport'] as const,
  registers: [registry],
})

export const opsRejected = new client.Counter({
  name: 'coboard_ops_rejected_total',
  help: 'Ops refused with a nack (socket) or an error status (REST), by code',
  labelNames: ['transport', 'code'] as const,
  registers: [registry],
})

export const jobFailures = new client.Counter({
  name: 'coboard_job_failures_total',
  help: 'Background job failures: snapshots and the hourly maintenance sweeps',
  // `task`, not `job`: Prometheus sets its own `job` label on every scraped
  // series and would rename ours to `exported_job`, so alerts grouping `by
  // (job)` saw only the scrape job name (Phase 15 audit).
  labelNames: ['task'] as const,
  registers: [registry],
})

// Zero-valued series from the first scrape, so `increase()` sees the first
// failure as a change from 0 rather than as a series appearing from nothing
// (which `increase` cannot measure, and the alert would miss).
for (const task of ['snapshot', 'guest_sweep', 'trash_purge', 'image_collect']) {
  jobFailures.inc({ task }, 0)
}
for (const transport of ['ws', 'rest']) opsAccepted.inc({ transport }, 0)

/**
 * One sample shared by the gauges that read it, for one scrape.
 *
 * `registry.metrics()` collects every metric in parallel, so without this the
 * two Redis gauges would issue two INFO commands per scrape, and the four pool
 * gauges four `$metrics` calls.
 */
function perScrape<T>(read: () => Promise<T>, ttlMs = 1_000): () => Promise<T> {
  let cached: { at: number; value: Promise<T> } | null = null
  return () => {
    const now = Date.now()
    if (!cached || now - cached.at > ttlMs) {
      const value = read()
      // A failure is not cached: the next scrape tries again.
      value.catch(() => {
        cached = null
      })
      cached = { at: now, value }
    }
    return cached.value
  }
}

/* ── Postgres pool ─────────────────────────────────────────────────────────── */

/**
 * The pool's configured size.
 *
 * Prisma exposes busy/idle/open but not the limit. An explicit
 * `connection_limit` in DATABASE_URL is exact. Without one Prisma uses
 * `physical CPUs × 2 + 1`; Node only reports LOGICAL CPUs, so on a
 * hyper-threaded host this overestimates the limit and the utilisation alert
 * fires late. Production sets `connection_limit` (see .env.example).
 */
export function poolLimit(databaseUrl = env().DATABASE_URL): number {
  try {
    const raw = new URL(databaseUrl).searchParams.get('connection_limit')
    const parsed = raw === null ? NaN : Number(raw)
    if (Number.isInteger(parsed) && parsed > 0) return parsed
  } catch {
    // Not a URL we can parse; fall through to the estimate.
  }
  return availableParallelism() * 2 + 1
}

const prismaSample = perScrape(async () => {
  const metrics = await prisma.$metrics.json()
  const gauge = (key: string) => metrics.gauges.find(g => g.key === key)?.value
  return {
    busy: gauge('prisma_pool_connections_busy'),
    idle: gauge('prisma_pool_connections_idle'),
    open: gauge('prisma_pool_connections_open'),
    waiting: gauge('prisma_client_queries_wait'),
  }
})

new client.Gauge({
  name: 'coboard_pg_pool_connections',
  help: 'Prisma connection pool, by state (busy, idle, open)',
  labelNames: ['state'] as const,
  registers: [registry],
  async collect() {
    this.reset()
    try {
      const sample = await prismaSample()
      for (const state of ['busy', 'idle', 'open'] as const) {
        const value = sample[state]
        if (value !== undefined) this.set({ state }, value)
      }
    } catch {
      // Left empty: an absent series is honest, a stale one is not.
    }
  },
})

new client.Gauge({
  name: 'coboard_pg_pool_connections_max',
  help: 'Configured pool size (connection_limit, or the Prisma default estimate)',
  registers: [registry],
  collect() {
    this.set(poolLimit())
  },
})

new client.Gauge({
  name: 'coboard_pg_queries_waiting',
  help: 'Queries waiting for a free pool connection',
  registers: [registry],
  async collect() {
    this.reset()
    try {
      const { waiting } = await prismaSample()
      if (waiting !== undefined) this.set(waiting)
    } catch {
      // As above.
    }
  },
})

/* ── Redis memory ──────────────────────────────────────────────────────────── */

/** Parse `used_memory` and `maxmemory` from `INFO memory`. */
export function parseRedisMemory(info: string): { used?: number; max?: number } {
  const field = (name: string) => {
    const match = new RegExp(`^${name}:(\\d+)\\s*$`, 'm').exec(info)
    return match ? Number(match[1]) : undefined
  }
  return { used: field('used_memory'), max: field('maxmemory') }
}

const redisSample = perScrape(async () => parseRedisMemory(await redis().info('memory')))

new client.Gauge({
  name: 'coboard_redis_memory_used_bytes',
  help: 'Redis used_memory, sampled from INFO at scrape time',
  registers: [registry],
  async collect() {
    this.reset()
    try {
      const { used } = await redisSample()
      if (used !== undefined) this.set(used)
    } catch {
      // Redis down: no sample. The fail-open paths keep the app running.
    }
  },
})

new client.Gauge({
  name: 'coboard_redis_maxmemory_bytes',
  help: 'Redis maxmemory (0 = no limit configured), sampled from INFO',
  registers: [registry],
  async collect() {
    this.reset()
    try {
      const { max } = await redisSample()
      if (max !== undefined) this.set(max)
    } catch {
      // As above.
    }
  },
})

/* ── HTTP route labels ─────────────────────────────────────────────────────── */

/** HTTP status → `2xx` … `5xx`. */
export const statusClass = (status: number): string => `${Math.floor(status / 100)}xx`
