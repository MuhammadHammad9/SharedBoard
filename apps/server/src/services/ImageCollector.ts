import type { PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from '../lib/prisma.js'
import { storageConfigured } from '../lib/env.js'
import { logger } from '../lib/logger.js'
import { storage } from '../lib/s3.js'

/**
 * Garbage collection for uploaded images — FR-CANVAS-010 storage lifecycle.
 *
 * Images cannot be deleted with their board: paste and Duplicate copy image
 * objects between boards BY URL, so `boards/{id}/…` can be in use on boards
 * other than `{id}`. What decides is a reference scan: an image is garbage
 * when NO op and NO snapshot on ANY board mentions its key.
 *
 * Ops are append-only, so an image whose object was deleted stays referenced
 * by its CREATE op — correctly, since undo can bring it back. Images become
 * collectable when the boards that used them are purged from Trash.
 *
 * A 7-day grace: an upload is confirmed BEFORE its create op exists, and that
 * op may sit in an offline client's outbox for days (FLOWS §9.4 warns at
 * 10 minutes, but does not drop anything).
 */

export const IMAGE_GRACE_MS = 7 * 24 * 60 * 60 * 1000

/** Per run, so one sweep never holds the database for long. */
const PER_RUN = 500

const likePattern = (key: string) => `%${key.replace(/[\\%_]/g, c => `\\${c}`)}%`

export class ImageCollector {
  constructor(private readonly db: PrismaClient = defaultPrisma) {}

  async isReferenced(key: string): Promise<boolean> {
    const pattern = likePattern(key)
    const rows = await this.db.$queryRaw<Array<{ used: boolean }>>`
      SELECT (
        EXISTS (SELECT 1 FROM "Operation" WHERE payload::text LIKE ${pattern})
        OR EXISTS (SELECT 1 FROM "Snapshot" WHERE state::text LIKE ${pattern})
      ) AS used`
    return rows[0]?.used ?? true
  }

  /** Deletes unreferenced images older than the grace. Returns how many. */
  async collect(now = Date.now()): Promise<number> {
    if (!storageConfigured()) return 0
    const candidates = (await storage.list('boards/'))
      .filter(o => now - o.modified.getTime() > IMAGE_GRACE_MS)
      .slice(0, PER_RUN)

    let removed = 0
    for (const { key } of candidates) {
      if (await this.isReferenced(key)) continue
      try {
        await storage.remove(key)
        removed += 1
      } catch (error) {
        logger.warn({ err: error, key }, 'could not delete an unreferenced image')
      }
    }
    return removed
  }
}

export const imageCollector = new ImageCollector()
