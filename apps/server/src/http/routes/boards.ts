import { Router } from 'express'
import { z } from 'zod'
import {
  ClientOpSchema,
  CreateBoardSchema,
  ERROR_CODES,
  ListBoardsQuerySchema,
  PermanentDeleteSchema,
  UpdateBoardSchema,
  type ServerOp,
} from '@coboard/shared'
import { boardService } from '../../services/BoardService.js'
import { opService } from '../../services/OpService.js'
import { permissionService } from '../../services/PermissionService.js'
import { snapshotService } from '../../services/SnapshotService.js'
import { liveRooms } from '../../ws/RoomManager.js'
import {
  assertAuthenticated,
  assertIdentified,
  identify,
  identifyOptional,
  identityOf,
} from '../middleware/auth.js'
import { SHARE_TOKEN, shareService } from '../../services/ShareService.js'
import {
  boardDeletedLive,
  boardRenamedLive,
  pushRoleChanged,
  revokeLive,
} from '../../ws/live.js'
import type { AccessChange } from '../../services/ShareService.js'
import { ah, HttpError } from '../middleware/errorHandler.js'
import { validateBody, validatedQuery, validateQuery } from '../middleware/validate.js'

/**
 * Board endpoints — TRD §4.2, FR-BOARD-001…007, FR-SYNC-008/009.
 *
 * Every handler authorizes through `PermissionService` before it touches
 * anything (R-SEC-001). None of them trusts a role sent by the client: the
 * client's own role check exists so a viewer sees a disabled button, and that
 * is all it is for.
 */

const AppendOpsSchema = z.object({
  ops: z.array(ClientOpSchema).min(1).max(200),
})

const SinceQuerySchema = z.object({
  sinceSeq: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(5_000).default(1_000),
})

const BoardIdSchema = z.string().uuid()

const AccessQuerySchema = z.object({
  share: z.string().regex(SHARE_TOKEN).optional(),
})

const LinkRoleSchema = z.object({ role: z.enum(['EDITOR', 'VIEWER']) })

/** Push the effects of a sharing change to the sockets it affected. */
function pushAccessChange(
  boardId: string,
  change: AccessChange,
  role?: 'EDITOR' | 'VIEWER',
) {
  for (const guestId of change.revokedGuests)
    revokeLive(boardId, { kind: 'guest', guestId })
  if (role) {
    for (const guestId of change.changedGuests) {
      pushRoleChanged(boardId, { kind: 'guest', guestId }, role)
    }
  }
}

const linkUrl = (token: string) => `/join/${token}`

/**
 * Reject a malformed id before it reaches Prisma.
 *
 * Postgres raises a type error on a non-uuid string in a uuid column, which
 * surfaces as a 500. A 404 is both the correct answer and the one that does
 * not log a stack trace every time a crawler tries `/api/boards/admin`.
 */
function boardId(raw: string | undefined): string {
  const parsed = BoardIdSchema.safeParse(raw)
  if (!parsed.success) {
    throw new HttpError(ERROR_CODES.NOT_FOUND, 'Board not found', 404)
  }
  return parsed.data
}

export function createBoardsRouter(): Router {
  const router = Router()

  /*
   * A signed-in user OR a guest (FR-AUTH-006). Routes a guest may not use —
   * the dashboard, creating, renaming, deleting, sharing — call
   * `assertAuthenticated`, which refuses a guest exactly as it refuses an
   * anonymous request. Only the board's own read and write paths take
   * `assertIdentified`, and those still go through the permission service.
   */
  /**
   * The guard's own endpoint — FLOWS §2.3 STEP 4. Registered BEFORE
   * `identify`, because an anonymous visitor holding a share link must be
   * able to ask too.
   *
   * It never returns the board's name — R-SEC-018 forbids showing it on the
   * refusal screens, and the surest way not to leak it is not to send it.
   *
   *   200 { role }                                      member → STEP 5
   *   200 { role: 'none', joinable, requiresName }     live link, no account
   *   403 { reason: 'no_access' | 'link_revoked' }     S-17
   *   404                                              S-18
   *   410 { reason: 'deleted' }                        S-18, "deleted" copy
   */
  router.get(
    '/:id/access',
    identifyOptional,
    validateQuery(AccessQuerySchema),
    ah(async (req, res) => {
      const id = boardId(req.params.id)
      const identity = identityOf(req)
      const access = await permissionService.resolve(id, identity ?? undefined)
      if (!access) throw new HttpError(ERROR_CODES.NOT_FOUND, 'Board not found', 404)
      if (access.deletedAt) {
        throw new HttpError(ERROR_CODES.NOT_FOUND, 'Board deleted', 410, {
          reason: 'deleted',
        })
      }
      if (access.role !== 'none') {
        res.json({ role: access.role })
        return
      }

      // Not a member. The share token, if the visitor came through /join,
      // decides the rest.
      const { share } = validatedQuery<z.infer<typeof AccessQuerySchema>>(req)
      const lookup = share ? await shareService.lookup(share) : null
      if (lookup?.status === 'ok' && lookup.boardId === id) {
        if (identity?.kind === 'user') {
          // A signed-in person with a live link just becomes a member.
          const role = await shareService.joinAsUser(lookup.link, id, identity.userId)
          res.json({ role })
          return
        }
        res.json({ role: 'none', joinable: true, requiresName: true })
        return
      }
      if (lookup?.status === 'revoked') {
        throw new HttpError(ERROR_CODES.FORBIDDEN, 'Link revoked', 403, {
          reason: 'link_revoked',
        })
      }
      throw new HttpError(ERROR_CODES.FORBIDDEN, 'No access', 403, {
        reason: 'no_access',
      })
    }),
  )

  router.use(identify)

  /* ── Collection ───────────────────────────────────────────────────────── */

  router.get(
    '/',
    validateQuery(ListBoardsQuerySchema),
    ah(async (req, res) => {
      const userId = assertAuthenticated(req)
      const query = validatedQuery<z.infer<typeof ListBoardsQuerySchema>>(req)
      res.json(await boardService.list(userId, query))
    }),
  )

  router.post(
    '/',
    validateBody(CreateBoardSchema),
    ah(async (req, res) => {
      const userId = assertAuthenticated(req)
      const { name } = req.body as z.infer<typeof CreateBoardSchema>
      res.status(201).json({ board: await boardService.create(userId, name) })
    }),
  )

  router.get(
    '/trash',
    ah(async (req, res) => {
      const userId = assertAuthenticated(req)
      res.json({ boards: await boardService.listTrash(userId) })
    }),
  )

  /* ── One board ────────────────────────────────────────────────────────── */

  router.get(
    '/:id',
    ah(async (req, res) => {
      const userId = assertAuthenticated(req)
      const id = boardId(req.params.id)
      const access = await permissionService.requireRead(id, userId)
      const board = await boardService.get(id, userId)
      res.json({ board, myRole: access.role })
    }),
  )

  router.patch(
    '/:id',
    validateBody(UpdateBoardSchema),
    ah(async (req, res) => {
      const userId = assertAuthenticated(req)
      const id = boardId(req.params.id)
      await permissionService.requireOwner(id, userId)
      const { name } = req.body as z.infer<typeof UpdateBoardSchema>
      if (name === undefined) {
        throw new HttpError(ERROR_CODES.VALIDATION_FAILED, 'Nothing to update', 422)
      }
      const board = await boardService.rename(id, userId, name)
      // FLOWS §9.5: the header updates live for everyone, no toast.
      boardRenamedLive(id, board.name)
      res.json({ board })
    }),
  )

  /** Soft delete — the board goes to Trash, nothing is destroyed. */
  router.delete(
    '/:id',
    ah(async (req, res) => {
      const userId = assertAuthenticated(req)
      const id = boardId(req.params.id)
      await permissionService.requireOwner(id, userId)
      const board = await boardService.trash(id, userId)
      // Every cached role on it is now wrong — the next op from anyone must
      // see a deleted board, not a 60-second-old grant.
      await permissionService.invalidate(id)
      // AT-23: everyone connected sees S-19, and the sockets close. The
      // outbox is not synced — the target is gone (FLOWS §9.5).
      boardDeletedLive(id)
      res.json({ board })
    }),
  )

  /* ── The share link — FR-SHARE-002/003, owner only ──────────────────────── */

  router.get(
    '/:id/share-link',
    ah(async (req, res) => {
      const userId = assertAuthenticated(req)
      const id = boardId(req.params.id)
      await permissionService.requireOwner(id, userId)
      const link = await shareService.live(id)
      res.json({
        link: link
          ? { token: link.token, role: link.role, url: linkUrl(link.token) }
          : null,
      })
    }),
  )

  /** Turn the link on, or change what it grants. */
  router.put(
    '/:id/share-link',
    validateBody(LinkRoleSchema),
    ah(async (req, res) => {
      const userId = assertAuthenticated(req)
      const id = boardId(req.params.id)
      await permissionService.requireOwner(id, userId)
      const { role } = req.body as z.infer<typeof LinkRoleSchema>
      const { link, change } = await shareService.enable(id, role, userId)
      pushAccessChange(id, change, role)
      res.json({ link: { token: link.token, role: link.role, url: linkUrl(link.token) } })
    }),
  )

  /** "Restricted": the link stops working; its guests are ejected. */
  router.delete(
    '/:id/share-link',
    ah(async (req, res) => {
      const userId = assertAuthenticated(req)
      const id = boardId(req.params.id)
      await permissionService.requireOwner(id, userId)
      pushAccessChange(id, await shareService.disable(id))
      res.json({ link: null })
    }),
  )

  /** A new token; anyone on the old link loses access. */
  router.post(
    '/:id/share-link/reset',
    ah(async (req, res) => {
      const userId = assertAuthenticated(req)
      const id = boardId(req.params.id)
      await permissionService.requireOwner(id, userId)
      const { link, change } = await shareService.reset(id, userId)
      pushAccessChange(id, change)
      res.json({ link: { token: link.token, role: link.role, url: linkUrl(link.token) } })
    }),
  )

  router.post(
    '/:id/restore',
    ah(async (req, res) => {
      const userId = assertAuthenticated(req)
      const id = boardId(req.params.id)
      await permissionService.requireOwner(id, userId)
      const board = await boardService.restore(id, userId)
      await permissionService.invalidate(id)
      res.json({ board })
    }),
  )

  /**
   * Irreversible. Gated on an exact name match — FR-BOARD-006.
   *
   * POST, not the `DELETE /boards/:id/permanent` the TRD table gives. A DELETE
   * with a REQUIRED body is poorly supported end to end — several proxies and
   * fetch implementations strip it — and a confirmation that can be silently
   * dropped in transit is not a confirmation. Recorded as defect D-9.
   */
  router.post(
    '/:id/permanent-delete',
    validateBody(PermanentDeleteSchema),
    ah(async (req, res) => {
      const userId = assertAuthenticated(req)
      const id = boardId(req.params.id)
      await permissionService.requireOwner(id, userId)
      const { confirmName } = req.body as z.infer<typeof PermanentDeleteSchema>
      await boardService.destroy(id, userId, confirmName)
      res.status(204).end()
    }),
  )

  router.post(
    '/:id/duplicate',
    ah(async (req, res) => {
      const userId = assertAuthenticated(req)
      const id = boardId(req.params.id)
      // Read access is enough to duplicate: a viewer may take their own copy
      // of something they can already see in full, and the copy is theirs.
      await permissionService.requireRead(id, userId)
      const board = await boardService.duplicate(id, userId, source =>
        snapshotService.materialise(source),
      )
      res.status(201).json({ board })
    }),
  )

  /* ── Content: the op log ──────────────────────────────────────────────── */

  /**
   * The board load — FR-SYNC-009, FLOWS §2.3 step 5.
   *
   * Returns materialised state plus the sequence number it is current as of.
   * The client MUST buffer socket ops until it has this seq and then drop
   * everything at or below it (R-SYNC-035); without that pairing, objects
   * flicker in and vanish on load.
   */
  router.get(
    '/:id/snapshot',
    ah(async (req, res) => {
      const identity = assertIdentified(req)
      const id = boardId(req.params.id)
      const access = await permissionService.requireRead(id, identity)
      const state = await snapshotService.materialise(id)
      res.json({
        objects: state.objects,
        seq: state.seq,
        myRole: access.role,
        // Safe to include HERE and nowhere else: this endpoint has already
        // established the caller may read the board. R-SEC-018 is about the
        // refusal path, and the refusal path is a 404 with no body.
        name: access.name,
        meta: { fromSnapshot: state.fromSnapshot, replayed: state.replayed },
      })
    }),
  )

  /** Gap fill after a reconnect — E-15. */
  router.get(
    '/:id/operations',
    validateQuery(SinceQuerySchema),
    ah(async (req, res) => {
      const identity = assertIdentified(req)
      const id = boardId(req.params.id)
      await permissionService.requireRead(id, identity)
      const { sinceSeq, limit } = validatedQuery<z.infer<typeof SinceQuerySchema>>(req)
      const ops = await opService.since(id, sinceSeq, limit)
      res.json({ ops, currentSeq: await opService.currentSeq(id) })
    }),
  )

  /**
   * Append ops — TRD §5.4.
   *
   * The REST path exists so Phase 8 can persist without the socket, and so the
   * offline outbox has somewhere to flush to. Phase 9's gateway calls the same
   * `OpService.append`, in the same order, for the same reason a permission
   * rule is not written twice.
   */
  router.post(
    '/:id/operations',
    validateBody(AppendOpsSchema),
    ah(async (req, res) => {
      const identity = assertIdentified(req)
      const id = boardId(req.params.id)
      // Step 1 of §5.4: AUTHORIZE. A viewer is refused here, before a single
      // row is written — test AT-20. The same cached check as the socket path.
      await permissionService.assertCanEdit(id, identity)

      const { ops } = req.body as z.infer<typeof AppendOpsSchema>
      const result = await opService.append(
        id,
        ops,
        identity.kind === 'user'
          ? { userId: identity.userId }
          : { guestId: identity.guestId },
      )
      const actorTag = identity.kind === 'user' ? identity.userId : 'guest'

      // Persisted, so it is safe to acknowledge — R-SYNC-012.
      res.json({ applied: result.applied, currentSeq: result.currentSeq })

      /*
       * BROADCAST, exactly as the socket path does (§5.4 step 7). The outbox
       * falls back to this route while its socket is down, and an op that is
       * stored but never broadcast is invisible to everyone else in the room
       * until they reload — and, if nothing is written after it, never
       * detected as a gap at all (F-8 in docs/REMAINING-WORK.md).
       *
       * There is no socket session here, so the author is not excluded: their
       * own socket receives the op too, in seq order, which the client treats
       * as the in-order echo of its own write.
       */
      const fresh = result.applied
        .filter(op => !op.duplicate)
        .map(op => ({
          id: op.id,
          type: op.type,
          objectId: op.objectId,
          payload: op.payload,
          seq: op.seq,
          actorSessionId: `rest:${actorTag}`,
        })) as ServerOp[]
      liveRooms().queueOps(id, fresh, `rest:${actorTag}`)

      /*
       * Snapshot AFTER responding, and deliberately un-awaited. It is a cache
       * refresh, not part of the write, and making the 500th op wait tens of
       * milliseconds for it would be a visible stutter for one unlucky user.
       */
      void snapshotService.maybeSnapshot(id)
    }),
  )

  return router
}
