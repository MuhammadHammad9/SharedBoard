import { logger } from '../lib/logger.js'
import { memberService } from '../services/MemberService.js'
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
    logger.warn({ err: error }, 'guest sweep failed')
  }
}

export function startMaintenance(): () => void {
  const timer = setInterval(() => void runMaintenance(), EVERY_MS)
  // Do not hold the process open for housekeeping.
  timer.unref?.()
  void runMaintenance()
  return () => clearInterval(timer)
}
