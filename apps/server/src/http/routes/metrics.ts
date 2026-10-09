import { createHash, timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { ERROR_CODES } from '@coboard/shared'
import { env } from '../../lib/env.js'
import { registry } from '../../lib/metrics.js'
import { ah, HttpError } from '../middleware/errorHandler.js'

/**
 * `GET /metrics` — Prometheus text format, TRD §15.4.
 *
 * Protected, because what it publishes (route names, error rates, pool sizes,
 * socket counts) is a map of the system:
 *
 * - `METRICS_TOKEN` set → `Authorization: Bearer <token>` required.
 * - unset in production → the endpoint answers 404, as if it did not exist.
 * - unset in development or test → open, so `curl localhost:3000/metrics`
 *   just works.
 *
 * The comparison hashes both sides first so `timingSafeEqual` always compares
 * equal-length buffers; comparing the raw strings would leak the token's
 * length through the early return on a mismatch.
 */

const digest = (value: string) => createHash('sha256').update(value).digest()

function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false
  return timingSafeEqual(digest(header.slice('Bearer '.length).trim()), digest(token))
}

export function createMetricsRouter(): Router {
  const router = Router()

  router.get(
    '/',
    ah(async (req, res) => {
      const { METRICS_TOKEN, NODE_ENV } = env()
      if (!METRICS_TOKEN && NODE_ENV === 'production') {
        throw new HttpError(ERROR_CODES.NOT_FOUND, 'Not found', 404)
      }
      if (METRICS_TOKEN && !bearerMatches(req.get('authorization'), METRICS_TOKEN)) {
        res.setHeader('WWW-Authenticate', 'Bearer')
        throw new HttpError(ERROR_CODES.UNAUTHORIZED, 'Metrics token required', 401)
      }
      res.setHeader('content-type', registry.contentType)
      res.setHeader('cache-control', 'no-store')
      res.send(await registry.metrics())
    }),
  )

  return router
}
