import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { ERROR_CODES } from '@coboard/shared'
import { permissionService } from '../../services/PermissionService.js'
import { redis } from '../../lib/redis.js'
import { assertAuthenticated, requireAuth } from '../middleware/auth.js'
import { ah, HttpError } from '../middleware/errorHandler.js'
import { validateBody } from '../middleware/validate.js'

/**
 * WebSocket tickets — TRD §5.1.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  WHY A TICKET AND NOT THE ACCESS TOKEN IN THE URL                        │
 * │                                                                          │
 * │  The browser `WebSocket` constructor cannot set an `Authorization`       │
 * │  header. That leaves three options, and two of them are bad:             │
 * │                                                                          │
 * │  1. Token in the query string. It lands in server access logs, in proxy  │
 * │     logs, and in the Referer of anything the page loads next. A 15-minute│
 * │     bearer token written to disk on three machines is a credential leak  │
 * │     with a schedule.                                                     │
 * │  2. Token in `Sec-WebSocket-Protocol`. It works and stays out of logs,   │
 * │     but the subprotocol value must be a token per RFC 6455 and JWTs      │
 * │     containing `.` and `-` survive only by accident of implementation.   │
 * │  3. A short-lived single-use ticket. It goes in the query string, and    │
 * │     that is fine, because a logged ticket is worthless: it lives 60      │
 * │     seconds and is deleted the moment it is redeemed.                    │
 * │                                                                          │
 * │  TRD §5.1 offers (2) or (3); this is (3).                                │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * The ticket also carries the board id and the resolved role, so the upgrade
 * handler does not have to re-run authorization at a point where it cannot
 * return a useful HTTP error.
 */

export const TICKET_TTL_SECONDS = 60

const TicketRequestSchema = z.object({ boardId: z.string().uuid() })

export interface TicketPayload {
  userId: string
  boardId: string
  role: string
}

const ticketKey = (ticket: string) => `ws:ticket:${ticket}`

/**
 * Redeem a ticket, atomically.
 *
 * GETDEL, not GET-then-DEL. Two upgrade requests racing on the same ticket
 * would otherwise both read it and both succeed, which turns "single-use" into
 * "single-use unless you are quick" — exactly the property the short TTL is
 * there to make unnecessary.
 */
export async function redeemTicket(ticket: string): Promise<TicketPayload | null> {
  if (!/^[0-9a-f]{64}$/.test(ticket)) return null
  const raw = await redis().getdel(ticketKey(ticket))
  if (!raw) return null
  try {
    return JSON.parse(raw) as TicketPayload
  } catch {
    return null
  }
}

export function createWsRouter(): Router {
  const router = Router()

  router.post(
    '/ticket',
    requireAuth,
    validateBody(TicketRequestSchema),
    ah(async (req, res) => {
      const userId = assertAuthenticated(req)
      const { boardId } = req.body as z.infer<typeof TicketRequestSchema>

      /*
       * Authorization happens HERE, over HTTP, where a refusal can be a 404
       * with an error envelope the client already knows how to read. The
       * upgrade handler can only close a socket with a numeric code, which is
       * a much worse place to discover you do not have access.
       */
      const access = await permissionService.requireRead(boardId, userId)

      const ticket = randomBytes(32).toString('hex')
      const payload: TicketPayload = { userId, boardId, role: access.role }

      const stored = await redis().set(
        ticketKey(ticket),
        JSON.stringify(payload),
        'EX',
        TICKET_TTL_SECONDS,
      )
      if (stored !== 'OK') {
        throw new HttpError(ERROR_CODES.INTERNAL, 'Could not issue a ticket', 503)
      }

      res.json({ ticket, expiresIn: TICKET_TTL_SECONDS })
    }),
  )

  return router
}
