import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import {
  ACCEPTED_IMAGE_TYPES,
  ERROR_CODES,
  MAX_UPLOAD_BYTES,
  type AcceptedImageType,
} from '@coboard/shared'
import { storageConfigured } from '../../lib/env.js'
import { EXTENSION, sniffImageType } from '../../lib/fileType.js'
import { identityKey } from '../../lib/identity.js'
import { logger } from '../../lib/logger.js'
import { AVATAR_KEY, ownAvatarKey, storage, UPLOAD_KEY } from '../../lib/s3.js'
import { sanitizeSvg } from '../../lib/svgSanitize.js'
import { consume, UPLOADS_BUCKET } from '../../lib/tokenBucket.js'
import { permissionService } from '../../services/PermissionService.js'
import { authService, toPublicUser } from '../../services/AuthService.js'
import { assertAuthenticated, assertIdentified, identify } from '../middleware/auth.js'
import { ah, HttpError } from '../middleware/errorHandler.js'
import { validateBody } from '../middleware/validate.js'

/**
 * Image uploads — FR-CANVAS-010, TRD §4.4, decision D-12.
 *
 *   presign   validate type and size, check edit rights, spend a rate-limit
 *             token, hand back a URL the browser PUTs the bytes to directly
 *   confirm   the object exists, its BYTES are an accepted image of the type
 *             that was signed for (R-SEC-012), an SVG is sanitized in place
 *             (R-SEC-011). Anything that fails is deleted, not left lying in
 *             a public bucket
 *
 * `boardId` is in the presign body although TRD §4.4 leaves it out (decision
 * D13-1): every request is authorized server-side (R-SEC-001), and an upload
 * is authorized by edit rights on the board it is for. The key carries the
 * board, so confirm can check the same thing without trusting the client.
 */

const PresignSchema = z.object({
  boardId: z.string().uuid(),
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(100),
  size: z.number().int().positive(),
})

const ConfirmSchema = z.object({ key: z.string().min(1).max(200) })

/** D-36: an avatar belongs to a user, not a board, so there is no boardId. */
const AvatarPresignSchema = z.object({
  contentType: z.string().min(1).max(100),
  size: z.number().int().positive(),
})

const AVATAR_TYPES: readonly AcceptedImageType[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]

const KEY = UPLOAD_KEY

const TYPE_OF_EXTENSION = Object.fromEntries(
  Object.entries(EXTENSION).map(([type, ext]) => [ext, type]),
) as Record<string, AcceptedImageType>

const isAccepted = (type: string): type is AcceptedImageType =>
  (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(type)

const tooLarge = () =>
  new HttpError(ERROR_CODES.VALIDATION_FAILED, 'File too large', 413, {
    reason: 'too_large',
    maxBytes: MAX_UPLOAD_BYTES,
  })

const unsupported = () =>
  new HttpError(ERROR_CODES.VALIDATION_FAILED, 'Unsupported file type', 415, {
    reason: 'unsupported_type',
  })

/**
 * SVG uploads are served as ATTACHMENTS — finding 6.
 *
 * Two windows used to let an unsanitized SVG execute on the storage origin:
 * the object is public between the PUT and `/confirm`, and the presigned URL
 * stays valid for ten minutes, so the same URL can re-PUT the original
 * payload over the sanitized copy after confirm. Both are closed by the
 * disposition rather than by a race: it is part of the PUT's SIGNATURE, so
 * every write through that URL — first or repeated — stores
 * `Content-Disposition: attachment`, and a browser navigating to the object
 * downloads it instead of rendering it as a document. `<img>` and canvas
 * rendering ignore the header, and an SVG loaded as an image never runs
 * script, so the board is unaffected. Confirm re-writes the sanitized bytes
 * with the same header.
 *
 * Chosen over a quarantine prefix + copy-on-confirm because that needs the
 * bucket policy to keep the quarantine prefix private — configuration this
 * code cannot enforce — while the signed header holds on any S3-compatible
 * store. Deployment note: the bucket's CORS rule must allow the
 * `content-disposition` request header, or the browser's PUT is preflighted
 * away.
 */
const SVG_DISPOSITION = 'attachment'

const dispositionFor = (contentType: AcceptedImageType): string | undefined =>
  contentType === 'image/svg+xml' ? SVG_DISPOSITION : undefined

function requireStorage(): void {
  if (!storageConfigured()) {
    throw new HttpError(ERROR_CODES.INTERNAL, 'Uploads are not available', 503, {
      reason: 'storage_unavailable',
    })
  }
}

export function createUploadsRouter(): Router {
  const router = Router()
  router.use(identify)

  router.post(
    '/presign',
    validateBody(PresignSchema),
    ah(async (req, res) => {
      const identity = assertIdentified(req)
      const { boardId, contentType, size } = req.body as z.infer<typeof PresignSchema>

      // Type and size BEFORE anything is signed or counted (TRD §4.4).
      if (!isAccepted(contentType)) throw unsupported()
      if (size > MAX_UPLOAD_BYTES) throw tooLarge()

      await permissionService.requireEdit(boardId, identity)
      requireStorage()

      if (!(await consume(`upload:${identityKey(identity)}`, 1, UPLOADS_BUCKET))) {
        throw new HttpError(ERROR_CODES.RATE_LIMITED, 'Too many uploads', 429)
      }

      const key = `boards/${boardId}/${randomUUID()}.${EXTENSION[contentType]}`
      const disposition = dispositionFor(contentType)
      res.json({
        uploadUrl: await storage.presignPut(key, contentType, size, disposition),
        publicUrl: storage.publicUrl(key),
        key,
        // The PUT must carry exactly these, or a real S3 rejects the signature.
        headers: {
          'content-type': contentType,
          ...(disposition ? { 'content-disposition': disposition } : {}),
        },
      })
    }),
  )

  router.post(
    '/confirm',
    validateBody(ConfirmSchema),
    ah(async (req, res) => {
      const identity = assertIdentified(req)
      const { key } = req.body as z.infer<typeof ConfirmSchema>
      const match = KEY.exec(key)
      if (!match) throw new HttpError(ERROR_CODES.NOT_FOUND, 'Upload not found', 404)
      const boardId = match[1]!
      const declared = TYPE_OF_EXTENSION[match[2]!]!

      await permissionService.requireEdit(boardId, identity)
      requireStorage()

      const head = await storage.head(key)
      if (!head) throw new HttpError(ERROR_CODES.NOT_FOUND, 'Upload not found', 404)

      const reject = async (error: HttpError): Promise<never> => {
        await storage
          .remove(key)
          .catch(err => logger.warn({ err, key }, 'could not delete a rejected upload'))
        throw error
      }

      if (head.size > MAX_UPLOAD_BYTES) return reject(tooLarge())

      const bytes = await storage.read(key)
      if (bytes.length > MAX_UPLOAD_BYTES) return reject(tooLarge())
      // R-SEC-012: the bytes decide, and they must be what was signed for.
      if (sniffImageType(bytes) !== declared) return reject(unsupported())

      if (declared === 'image/svg+xml') {
        // Signed into the PUT, so it can only be missing if something went
        // around the presigned URL. Refused rather than repaired.
        if (head.contentDisposition !== SVG_DISPOSITION) return reject(unsupported())
        const clean = sanitizeSvg(new TextDecoder().decode(bytes))
        if (!clean) return reject(unsupported())
        await storage.put(key, clean, declared, SVG_DISPOSITION)
      }

      res.json({ url: storage.publicUrl(key), contentType: declared })
    }),
  )

  /*
   * Avatars — FR-SET-001, D-36. The same presign → PUT → confirm round trip,
   * keyed to the USER instead of a board: only a signed-in user has a profile
   * (a guest gets the 401 `assertAuthenticated` gives every guest), and only
   * the user named in the key may confirm it. Confirm is what sets
   * `avatarUrl` — PATCH /auth/me no longer accepts a URL at all, so an avatar
   * can only ever point at bytes this server has looked at.
   */
  router.post(
    '/avatar/presign',
    validateBody(AvatarPresignSchema),
    ah(async (req, res) => {
      const userId = assertAuthenticated(req)
      const { contentType, size } = req.body as z.infer<typeof AvatarPresignSchema>

      if (!isAccepted(contentType) || !AVATAR_TYPES.includes(contentType)) {
        throw unsupported()
      }
      if (size > MAX_UPLOAD_BYTES) throw tooLarge()
      requireStorage()

      if (!(await consume(`upload:user:${userId}`, 1, UPLOADS_BUCKET))) {
        throw new HttpError(ERROR_CODES.RATE_LIMITED, 'Too many uploads', 429)
      }

      const key = `avatars/${userId}/${randomUUID()}.${EXTENSION[contentType]}`
      res.json({
        uploadUrl: await storage.presignPut(key, contentType, size),
        publicUrl: storage.publicUrl(key),
        key,
        headers: { 'content-type': contentType },
      })
    }),
  )

  router.post(
    '/avatar/confirm',
    validateBody(ConfirmSchema),
    ah(async (req, res) => {
      const userId = assertAuthenticated(req)
      const { key } = req.body as z.infer<typeof ConfirmSchema>
      const match = AVATAR_KEY.exec(key)
      // Someone else's key answers exactly like a missing one.
      if (!match || match[1] !== userId) {
        throw new HttpError(ERROR_CODES.NOT_FOUND, 'Upload not found', 404)
      }
      const declared = TYPE_OF_EXTENSION[match[2]!]!
      requireStorage()

      const head = await storage.head(key)
      if (!head) throw new HttpError(ERROR_CODES.NOT_FOUND, 'Upload not found', 404)

      const reject = async (error: HttpError): Promise<never> => {
        await storage
          .remove(key)
          .catch(err => logger.warn({ err, key }, 'could not delete a rejected avatar'))
        throw error
      }
      if (head.size > MAX_UPLOAD_BYTES) return reject(tooLarge())
      const bytes = await storage.read(key)
      if (bytes.length > MAX_UPLOAD_BYTES) return reject(tooLarge())
      // R-SEC-012: the bytes decide.
      if (sniffImageType(bytes) !== declared) return reject(unsupported())

      const previous = (await authService.findById(userId))?.avatarUrl
      const user = await authService.updateProfile(userId, {
        avatarUrl: storage.publicUrl(key),
      })
      // The photo it replaced is nobody's any more.
      const stale = ownAvatarKey(previous, userId)
      if (stale && stale !== key) {
        await storage
          .remove(stale)
          .catch(err =>
            logger.warn({ err, key: stale }, 'could not delete an old avatar'),
          )
      }
      res.json({ user: toPublicUser(user) })
    }),
  )

  return router
}
