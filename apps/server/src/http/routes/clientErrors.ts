import { Router } from 'express'
import { z } from 'zod'
import { ERROR_CODES } from '@coboard/shared'
import { logger } from '../../lib/logger.js'
import { consume, type Bucket } from '../../lib/tokenBucket.js'
import { identifyOptional, identityOf } from '../middleware/auth.js'
import { ah, HttpError } from '../middleware/errorHandler.js'
import { clientIp } from '../middleware/rateLimit.js'
import { validateBody } from '../middleware/validate.js'

/**
 * Client error reports — S-21, FLOWS §12.4, PRD §9 `client_error`.
 *
 * The error boundary shows the user ONLY a short correlation id and sends the
 * rest here: message, component stack, board id, and who they were — so the
 * id they read out in a support message finds the full record in the logs.
 * The error service proper is Phase 15; until then, this is a structured log
 * line, and the id is the join key.
 *
 * Open to anyone (an error can happen before sign-in), so it is bounded: every
 * field has a length cap, and each IP may send 30 a minute. A report that
 * fails is dropped silently by the client — reporting must never itself
 * become a new error the user sees.
 */

const ReportSchema = z.object({
  correlationId: z.string().regex(/^[0-9a-f]{8}$/),
  message: z.string().min(1).max(500),
  component: z.string().max(200).optional(),
  stack: z.string().max(8_000).optional(),
  componentStack: z.string().max(8_000).optional(),
  boardId: z.string().uuid().optional(),
  url: z.string().max(2_000).optional(),
  source: z.enum(['boundary', 'canvas-boundary', 'window', 'promise']),
})

const REPORTS_BUCKET: Bucket = { rate: 30 / 60, capacity: 30 }

export function createClientErrorsRouter(): Router {
  const router = Router()

  router.post(
    '/',
    identifyOptional,
    validateBody(ReportSchema),
    ah(async (req, res) => {
      if (!(await consume(`client-errors:${clientIp(req)}`, 1, REPORTS_BUCKET))) {
        throw new HttpError(ERROR_CODES.RATE_LIMITED, 'Too many reports', 429)
      }
      const report = req.body as z.infer<typeof ReportSchema>
      const identity = identityOf(req)
      logger.warn(
        {
          clientError: report,
          // A guest id is a credential (D-1): logged as "guest", never the id.
          actor:
            identity?.kind === 'user'
              ? `user:${identity.userId}`
              : identity
                ? 'guest'
                : null,
          userAgent: req.get('user-agent')?.slice(0, 300),
        },
        `client error ${report.correlationId}`,
      )
      res.status(204).end()
    }),
  )

  return router
}
