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
import { storage } from '../../lib/s3.js'
import { sanitizeSvg } from '../../lib/svgSanitize.js'
import { consume, UPLOADS_BUCKET } from '../../lib/tokenBucket.js'
import { permissionService } from '../../services/PermissionService.js'
import { assertIdentified, identify } from '../middleware/auth.js'
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

const KEY = /^boards\/([0-9a-f-]{36})\/[0-9a-f-]{36}\.(png|jpg|gif|webp|svg)$/

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
      res.json({
        uploadUrl: await storage.presignPut(key, contentType, size),
        publicUrl: storage.publicUrl(key),
        key,
        // The PUT must carry exactly this, or a real S3 rejects the signature.
        headers: { 'content-type': contentType },
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
        const clean = sanitizeSvg(new TextDecoder().decode(bytes))
        if (!clean) return reject(unsupported())
        await storage.put(key, clean, declared)
      }

      res.json({ url: storage.publicUrl(key), contentType: declared })
    }),
  )

  return router
}
