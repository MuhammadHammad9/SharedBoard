import type { Request, RequestHandler } from 'express'
import { newCorrelationId } from '@coboard/shared'
import { logger, type Logger } from '../../lib/logger.js'
import { httpRequests, statusClass } from '../../lib/metrics.js'

/**
 * Request correlation — TRD §15.4, PRD §8.1, Phase 15e.
 *
 * Every request gets an id that appears in three places: the `x-request-id`
 * response header, every log line written for it (through a pino child), and
 * the `correlationId` of any error envelope. The last one is what the client
 * shows as "Ref: …", so the id a user reads out in a support message is the
 * id that finds the server's log lines.
 *
 * An incoming `x-request-id` is kept when it is sane, so an id minted by the
 * web client or by the edge proxy survives end to end. "Sane" is strict: up to
 * 64 characters of `[A-Za-z0-9_-]`. Anything else — a newline, a 10 KB string,
 * a JSON fragment — is a log-injection attempt or a bug, and is replaced with
 * a freshly minted id rather than echoed back or written into the logs.
 *
 * Minted ids use the same 8-hex format as every other correlation id in the
 * product: short enough to read aloud.
 */

export const REQUEST_ID_HEADER = 'x-request-id'

const SANE_ID = /^[A-Za-z0-9_-]{1,64}$/

export interface TracedRequest extends Request {
  id: string
  log: Logger
}

/** The request's id; mints one if the middleware did not run (unit tests). */
export function requestId(req: Request): string {
  return (req as Partial<TracedRequest>).id ?? newCorrelationId()
}

/** The request's child logger, or the root logger outside a request. */
export function requestLog(req: Request): Logger {
  return (req as Partial<TracedRequest>).log ?? logger
}

export function acceptRequestId(raw: string | undefined): string {
  return raw !== undefined && SANE_ID.test(raw) ? raw : newCorrelationId()
}

/**
 * Where a router is mounted, recorded so the metrics label can be the route
 * PATTERN (`/api/boards/:id/operations`) rather than the concrete URL. By the
 * time a failed request finishes, Express has already unwound `req.baseUrl`,
 * so it is captured on the way in.
 */
export const mountedAt =
  (base: string): RequestHandler =>
  (_req, res, next) => {
    res.locals.routeBase = base
    next()
  }

function routeLabel(req: Request, base: unknown): string {
  // No matched route means a 404 for an arbitrary path. Using the path itself
  // would let any scanner mint unbounded label values.
  const pattern = (req.route as { path?: unknown } | undefined)?.path
  if (typeof pattern !== 'string') return 'unmatched'
  return `${typeof base === 'string' ? base : ''}${pattern}`
}

export const requestContext: RequestHandler = (req, res, next) => {
  const id = acceptRequestId(req.get(REQUEST_ID_HEADER))
  const traced = req as TracedRequest
  traced.id = id
  traced.log = logger.child({ requestId: id })
  res.setHeader(REQUEST_ID_HEADER, id)

  res.on('finish', () => {
    httpRequests.inc({
      route: routeLabel(req, res.locals.routeBase),
      method: req.method,
      status_class: statusClass(res.statusCode),
    })
  })
  next()
}
