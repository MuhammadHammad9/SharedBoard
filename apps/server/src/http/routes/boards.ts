import { Router } from 'express'
import { z } from 'zod'
import {
  ClientOpSchema,
  CreateBoardSchema,
  ERROR_CODES,
  ListBoardsQuerySchema,
  PermanentDeleteSchema,
  UpdateBoardSchema,
} from '@coboard/shared'
import { boardService } from '../../services/BoardService.js'
import { opService } from '../../services/OpService.js'
import { permissionService } from '../../services/PermissionService.js'
import { snapshotService } from '../../services/SnapshotService.js'
import { assertAuthenticated, requireAuth } from '../middleware/auth.js'
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

  // Every route below requires a signed-in user. Guest access to a shared
  // board arrives with share links in Phase 12.
  router.use(requireAuth)

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

  /**
   * The guard's own endpoint — FLOWS §2.3 STEP 4.
   *
   * Separate from `GET /:id` on purpose. The guard needs to know whether the
   * user may enter BEFORE the board route mounts, and it must be able to ask
   * without receiving the board's name — R-SEC-018 forbids showing that on the
   * 403 screen, and the surest way not to leak it is not to send it.
   */
  router.get(
    '/:id/access',
    ah(async (req, res) => {
      const userId = assertAuthenticated(req)
      const id = boardId(req.params.id)
      const access = await permissionService.resolve(id, userId)
      if (!access || access.deletedAt) {
        res.json({ role: 'none', joinable: false })
        return
      }
      res.json({ role: access.role, joinable: false })
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
      res.json({ board: await boardService.rename(id, userId, name) })
    }),
  )

  /** Soft delete — the board goes to Trash, nothing is destroyed. */
  router.delete(
    '/:id',
    ah(async (req, res) => {
      const userId = assertAuthenticated(req)
      const id = boardId(req.params.id)
      await permissionService.requireOwner(id, userId)
      res.json({ board: await boardService.trash(id, userId) })
    }),
  )

  router.post(
    '/:id/restore',
    ah(async (req, res) => {
      const userId = assertAuthenticated(req)
      const id = boardId(req.params.id)
      await permissionService.requireOwner(id, userId)
      res.json({ board: await boardService.restore(id, userId) })
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
      const userId = assertAuthenticated(req)
      const id = boardId(req.params.id)
      const access = await permissionService.requireRead(id, userId)
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
      const userId = assertAuthenticated(req)
      const id = boardId(req.params.id)
      await permissionService.requireRead(id, userId)
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
      const userId = assertAuthenticated(req)
      const id = boardId(req.params.id)
      // Step 1 of §5.4: AUTHORIZE. A viewer is refused here, before a single
      // row is written — test AT-20.
      await permissionService.requireEdit(id, userId)

      const { ops } = req.body as z.infer<typeof AppendOpsSchema>
      const result = await opService.append(id, ops, { userId })

      // Persisted, so it is safe to acknowledge — R-SYNC-012.
      res.json({ applied: result.applied, currentSeq: result.currentSeq })

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
