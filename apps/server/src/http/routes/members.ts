import { Router } from 'express'
import { z } from 'zod'
import { ERROR_CODES } from '@coboard/shared'
import { env } from '../../lib/env.js'
import { memberService } from '../../services/MemberService.js'
import { permissionService } from '../../services/PermissionService.js'
import { pushRoleChanged, revokeLive } from '../../ws/live.js'
import { assertAuthenticated, assertIdentified, identify } from '../middleware/auth.js'
import { ah, HttpError } from '../middleware/errorHandler.js'
import { validateBody } from '../middleware/validate.js'

/**
 * People with access — TRD §4.3, FLOWS §10.2, FR-SHARE-001/004.
 *
 *   GET    /boards/:id/members            any signed-in member
 *   POST   /boards/:id/members            owner — invite by email
 *   PATCH  /boards/:id/members/:memberId  owner — emits role_changed
 *   DELETE /boards/:id/members/me         any member, guests included — leave
 *   DELETE /boards/:id/members/:memberId  owner — emits access_revoked
 *
 * Listing is for signed-in members only: it carries members' email addresses,
 * and a guest holding a link has no business collecting those.
 */

const InviteSchema = z.object({
  emails: z.array(z.string().min(1).max(254)).min(1).max(50),
  role: z.enum(['EDITOR', 'VIEWER']),
})

const RoleSchema = z.object({ role: z.enum(['EDITOR', 'VIEWER']) })

const ClaimGuestSchema = z.object({ guestId: z.string().uuid() })

const Uuid = z.string().uuid()

function uuidParam(raw: string | undefined, what: string): string {
  const parsed = Uuid.safeParse(raw)
  if (!parsed.success)
    throw new HttpError(ERROR_CODES.NOT_FOUND, `${what} not found`, 404)
  return parsed.data
}

export function createMembersRouter(): Router {
  // `mergeParams`, because this is mounted under /boards/:id.
  const router = Router({ mergeParams: true })
  router.use(identify)

  router.get(
    '/',
    ah(async (req, res) => {
      const userId = assertAuthenticated(req)
      const boardId = uuidParam(req.params.id, 'Board')
      await permissionService.requireRead(boardId, userId)
      res.json(await memberService.list(boardId))
    }),
  )

  router.post(
    '/',
    validateBody(InviteSchema),
    ah(async (req, res) => {
      const userId = assertAuthenticated(req)
      const boardId = uuidParam(req.params.id, 'Board')
      await permissionService.requireOwner(boardId, userId)
      const { emails, role } = req.body as z.infer<typeof InviteSchema>
      res.json(
        await memberService.invite(boardId, emails, role, userId, env().CLIENT_ORIGIN),
      )
    }),
  )

  /** Guest → account (FLOWS §7.4): the new account takes over the guest's seat. */
  router.post(
    '/claim-guest',
    validateBody(ClaimGuestSchema),
    ah(async (req, res) => {
      const userId = assertAuthenticated(req)
      const boardId = uuidParam(req.params.id, 'Board')
      const { guestId } = req.body as z.infer<typeof ClaimGuestSchema>
      const role = await memberService.claimGuest(boardId, guestId, userId)
      res.json({ role })
    }),
  )

  // Before `/:memberId`, or "me" would be read as a member id.
  router.delete(
    '/me',
    ah(async (req, res) => {
      const identity = assertIdentified(req)
      const boardId = uuidParam(req.params.id, 'Board')
      await memberService.leave(boardId, identity)
      // Their other tabs on this board are told too.
      revokeLive(boardId, identity)
      res.status(204).end()
    }),
  )

  router.patch(
    '/:memberId',
    validateBody(RoleSchema),
    ah(async (req, res) => {
      const userId = assertAuthenticated(req)
      const boardId = uuidParam(req.params.id, 'Board')
      const memberId = uuidParam(req.params.memberId, 'Member')
      await permissionService.requireOwner(boardId, userId)
      const { role } = req.body as z.infer<typeof RoleSchema>
      const identity = await memberService.setRole(boardId, memberId, role)
      // FLOWS §9.5: a demotion to viewer does NOT eject.
      pushRoleChanged(boardId, identity, role)
      res.json({ id: memberId, role })
    }),
  )

  router.delete(
    '/:memberId',
    ah(async (req, res) => {
      const userId = assertAuthenticated(req)
      const boardId = uuidParam(req.params.id, 'Board')
      const memberId = uuidParam(req.params.memberId, 'Member')
      await permissionService.requireOwner(boardId, userId)
      const identity = await memberService.remove(boardId, memberId)
      revokeLive(boardId, identity)
      res.status(204).end()
    }),
  )

  return router
}
