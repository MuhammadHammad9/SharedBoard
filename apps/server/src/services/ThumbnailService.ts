import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { ERROR_CODES } from '@coboard/shared'
import { prisma as defaultPrisma } from '../lib/prisma.js'
import { storageConfigured } from '../lib/env.js'
import { sniffImageType } from '../lib/fileType.js'
import { logger } from '../lib/logger.js'
import { storage } from '../lib/s3.js'
import { AuthError } from './AuthService.js'

/**
 * Board thumbnails — FR-BOARD-003, decision D13-4.
 *
 * Rendered by a client, uploaded here (a ~30 KB JPEG, so through the server
 * rather than presigned), stored under a FRESH key each time so a cached old
 * thumbnail can never be served for the new one, and the previous object
 * deleted.
 *
 * Thumbnails belong to exactly one board and no op ever refers to one, so
 * deleting them is safe — unlike uploaded images, which paste and Duplicate
 * share between boards by URL, and which are therefore never deleted with a
 * board (see docs/REMAINING-WORK.md, Phase 13).
 */

/** A 640×400 JPEG at 0.7 is ~30 KB; anything near this cap is not one. */
export const THUMBNAIL_MAX_BYTES = 512 * 1024

const keyFor = (boardId: string) => `thumbnails/${boardId}/${randomUUID()}.jpg`

export class ThumbnailService {
  constructor(private readonly db: PrismaClient = defaultPrisma) {}

  async store(boardId: string, bytes: Uint8Array): Promise<string> {
    this.requireStorage()
    if (bytes.length === 0 || bytes.length > THUMBNAIL_MAX_BYTES) {
      throw new AuthError(ERROR_CODES.VALIDATION_FAILED, 'Thumbnail too large', 413)
    }
    // R-SEC-012: the bytes decide. Only a JPEG is a thumbnail.
    if (sniffImageType(bytes) !== 'image/jpeg') {
      throw new AuthError(ERROR_CODES.VALIDATION_FAILED, 'Not a JPEG', 415)
    }
    const key = keyFor(boardId)
    await storage.put(key, bytes, 'image/jpeg')
    return this.swap(boardId, storage.publicUrl(key))
  }

  /** An empty board shows the placeholder graphic, not a blank image. */
  async clear(boardId: string): Promise<void> {
    await this.swap(boardId, null)
  }

  /** Duplicate: the copy gets its OWN object, so neither board's later
   *  replacement can delete the other's picture. Best effort. */
  async copy(fromBoardId: string, toBoardId: string): Promise<void> {
    if (!storageConfigured()) return
    try {
      const source = await this.db.board.findUnique({
        where: { id: fromBoardId },
        select: { thumbnailUrl: true },
      })
      const fromKey = source?.thumbnailUrl ? storage.keyOf(source.thumbnailUrl) : null
      if (!fromKey) return
      const key = keyFor(toBoardId)
      await storage.put(key, await storage.read(fromKey), 'image/jpeg')
      await this.db.board.update({
        where: { id: toBoardId },
        data: { thumbnailUrl: storage.publicUrl(key) },
      })
    } catch (error) {
      logger.warn({ err: error, fromBoardId, toBoardId }, 'thumbnail copy failed')
    }
  }

  /** Delete a thumbnail's object once nothing points at it. Best effort. */
  async discard(url: string | null | undefined): Promise<void> {
    const key = url ? storage.keyOf(url) : null
    if (!key || !key.startsWith('thumbnails/') || !storageConfigured()) return
    await storage
      .remove(key)
      .catch(error =>
        logger.warn({ err: error, key }, 'could not delete an old thumbnail'),
      )
  }

  private async swap(boardId: string, url: string | null): Promise<string> {
    const before = await this.db.board.findUnique({
      where: { id: boardId },
      select: { thumbnailUrl: true },
    })
    await this.db.board.update({ where: { id: boardId }, data: { thumbnailUrl: url } })
    if (before?.thumbnailUrl && before.thumbnailUrl !== url) {
      await this.discard(before.thumbnailUrl)
    }
    return url ?? ''
  }

  private requireStorage(): void {
    if (!storageConfigured()) {
      throw new AuthError(ERROR_CODES.INTERNAL, 'Storage is not configured', 503)
    }
  }
}

export const thumbnailService = new ThumbnailService()
