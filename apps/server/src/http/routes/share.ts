import { Router } from 'express'
import { z } from 'zod'
import { ERROR_CODES } from '@coboard/shared'
import { shareService, type TokenLookup } from '../../services/ShareService.js'
import { liveRooms } from '../../ws/RoomManager.js'
import { ah, HttpError } from '../middleware/errorHandler.js'
import { validateBody } from '../middleware/validate.js'

/**
 * The public half of sharing — FLOWS §7, S-11.
 *
 * No authentication: the token IS the credential, and the person holding it
 * may have no account at all. What these endpoints reveal is bounded by what
 * the token already grants — someone with a live link can join the board and
 * see everything on it, so showing them its name and who is there first
 * gives nothing away. A dead or wrong token reveals nothing beyond the fact.
 */

const JoinSchema = z.object({
  /** The guest's own id — a uuid it generated (FR-AUTH-006, decision D-1). */
  guestId: z.string().uuid(),
  /** 1–40 characters after trimming — FLOWS §7.3. */
  name: z.string().trim().min(1).max(40),
})

/** How many avatars the join card shows before "+N". */
const CARD_AVATARS = 5

/** Turn a failed lookup into the FLOWS §7.3 response. */
function refuse(lookup: Exclude<TokenLookup, { status: 'ok' }>): never {
  if (lookup.status === 'invalid') {
    throw new HttpError(ERROR_CODES.NOT_FOUND, 'Invalid link', 404, { reason: 'invalid' })
  }
  throw new HttpError(ERROR_CODES.NOT_FOUND, 'Link no longer works', 410, {
    reason: lookup.status === 'revoked' ? 'revoked' : 'deleted',
  })
}

export function createShareRouter(): Router {
  const router = Router()

  /** The join card's content — FLOWS §7.1 step 3. */
  router.get(
    '/:token',
    ah(async (req, res) => {
      const lookup = await shareService.lookup(String(req.params.token))
      if (lookup.status !== 'ok') refuse(lookup)

      // "3 people are here now" with their avatars — social proof (S-11).
      // People, not sockets: two tabs of one person count once.
      const seen = new Set<string>()
      const present: Array<{ name: string; colour: string }> = []
      for (const s of liveRooms().sessions(lookup.boardId)) {
        const who = s.userId ?? `guest:${s.displayName}:${s.colour}`
        if (seen.has(who)) continue
        seen.add(who)
        present.push({ name: s.displayName, colour: s.colour })
      }

      res.json({
        // Not a secret from someone holding a live token — the token alone
        // lets them join. A signed-in visitor goes straight to the board with
        // it, and `/access` makes them a member (decision D-3).
        boardId: lookup.boardId,
        boardName: lookup.boardName,
        ownerName: lookup.ownerName,
        role: lookup.link.role,
        activeCount: present.length,
        present: present.slice(0, CARD_AVATARS),
      })
    }),
  )

  /** A guest joins — FLOWS §7.1 step 6. */
  router.post(
    '/:token/join',
    validateBody(JoinSchema),
    ah(async (req, res) => {
      const lookup = await shareService.lookup(String(req.params.token))
      if (lookup.status !== 'ok') refuse(lookup)

      // FLOWS §7.3: "This board is full right now" — refused here, before a
      // membership is created for someone who could not get in anyway.
      if (liveRooms().isFull(lookup.boardId)) {
        throw new HttpError(ERROR_CODES.FORBIDDEN, 'Board is full', 403, {
          reason: 'board_full',
        })
      }

      const { guestId, name } = req.body as z.infer<typeof JoinSchema>
      const role = await shareService.joinAsGuest(
        lookup.link,
        lookup.boardId,
        guestId,
        name,
      )
      res.json({ boardId: lookup.boardId, role })
    }),
  )

  return router
}
