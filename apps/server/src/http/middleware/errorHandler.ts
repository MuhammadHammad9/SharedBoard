import type { ErrorRequestHandler, RequestHandler } from 'express'
import { ZodError } from 'zod'
import { ERROR_CODES, newCorrelationId, type ErrorEnvelope } from '@coboard/shared'
import { AuthError } from '../../services/AuthService.js'
import { logger } from '../../lib/logger.js'

/**
 * The single place an error becomes a response — TRD §4.
 *
 * Every route throws; none of them writes an error body. That is what keeps
 * the envelope identical across the product and stops a stack trace reaching
 * a user, which PRD §8.1 forbids outright.
 */

export function envelope(
  code: string,
  message: string,
  correlationId: string,
  details?: Record<string, unknown>,
  retryAfter?: number,
): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      correlationId,
      ...(details ? { details } : {}),
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    },
  }
}

/** Thrown by routes for anything that is not an AuthError. */
export class HttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
    readonly retryAfter?: number,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export const notFoundHandler: RequestHandler = (req, res) => {
  const correlationId = newCorrelationId()
  res
    .status(404)
    .json(
      envelope(
        ERROR_CODES.NOT_FOUND,
        `No route for ${req.method} ${req.path}`,
        correlationId,
      ),
    )
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const correlationId = newCorrelationId()

  if (err instanceof AuthError || err instanceof HttpError) {
    const retryAfter = err instanceof HttpError ? err.retryAfter : undefined
    logger.info({ correlationId, code: err.code, path: req.path }, 'request rejected')
    res
      .status(err.status)
      .json(envelope(err.code, err.message, correlationId, err.details, retryAfter))
    return
  }

  if (err instanceof ZodError) {
    // Field-level detail so the form can map each issue onto its input
    // (FLOWS §3.1 branch 8c). Only the path and a code — never the value,
    // which for a password field would put the secret in the response.
    const details: Record<string, unknown> = {}
    for (const issue of err.issues) {
      details[issue.path.join('.') || '_'] = issue.code
    }
    res
      .status(422)
      .json(
        envelope(
          ERROR_CODES.VALIDATION_FAILED,
          'Validation failed',
          correlationId,
          details,
        ),
      )
    return
  }

  /*
   * Anything reaching here is a bug. The correlation id is logged WITH the
   * stack and returned WITHOUT it, so support can join the two without the
   * response ever carrying internals (PRD §8.1).
   */
  logger.error({ correlationId, err, path: req.path }, 'unhandled error')
  res
    .status(500)
    .json(envelope(ERROR_CODES.INTERNAL, 'Internal server error', correlationId))
}

/**
 * Wrap an async handler so a rejected promise reaches `errorHandler`.
 *
 * Express 4 does not await handlers. Without this an `await` that throws
 * becomes an unhandled rejection and the request hangs until the client times
 * out — no response, no log line, no clue. Express 5 fixes it natively; until
 * the upgrade, every async handler goes through here.
 */
export const ah =
  <T extends RequestHandler>(handler: T): RequestHandler =>
  (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next)
  }
