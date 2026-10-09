import { logger } from '../lib/logger.js'
import { jobFailures } from '../lib/metrics.js'
import { boardService } from '../services/BoardService.js'
import { imageCollector } from '../services/ImageCollector.js'
import { memberService } from '../services/MemberService.js'
import { thumbnailService } from '../services/ThumbnailService.js'
import { presenceService } from '../services/PresenceService.js'

/**
 * Housekeeping that no request triggers — run on a timer by the server
 * process, never by tests (they call the sweeps directly with a fixed `now`).
 *
 * Every instance runs it. Each sweep is a set of idempotent deletes guarded
 * by timestamps, so two instances running it at once delete the same rows
 * once; nothing here needs a lock.
 */

const EVERY_MS = 60 * 60 * 1000

/** Anyone connected to this board on any instance — the Redis presence hash. */
const isLive = async (boardId: string): Promise<boolean> =>
  (await presenceService.list(boardId)).length > 0

export async function runMaintenance(now = Date.now()): Promise<void> {
  try {
    const guests = await memberService.sweepIdleGuests(isLive, now)
    if (guests > 0) logger.info({ guests }, 'swept idle guests')
  } catch (error) {
    jobFailures.inc({ task: 'guest_sweep' })
    logger.warn({ err: error }, 'guest sweep failed')
  }

  // FR-BOARD-006: Trash keeps a board 30 days, then it is gone for good.
  try {
    const purged = await boardService.purgeExpiredTrash(new Date(now), async urls => {
      await Promise.all(urls.map(url => thumbnailService.discard(url)))
    })
    if (purged > 0) logger.info({ purged }, 'purged expired trash')
  } catch (error) {
    jobFailures.inc({ task: 'trash_purge' })
    logger.warn({ err: error }, 'trash purge failed')
  }

  // After the purge: boards just purged may have held the last reference.
  try {
    const images = await imageCollector.collect(now)
    if (images > 0) logger.info({ images }, 'collected unreferenced images')
  } catch (error) {
    jobFailures.inc({ task: 'image_collect' })
    logger.warn({ err: error }, 'image collection failed')
  }
}

export function startMaintenance(): () => void {
  const timer = setInterval(() => void runMaintenance(), EVERY_MS)
  // Do not hold the process open for housekeeping.
  timer.unref?.()
  void runMaintenance()
  return () => clearInterval(timer)
}
