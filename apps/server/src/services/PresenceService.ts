import { PRESENCE_SWEEP_IDLE_MS, type PresenceUser } from '@coboard/shared'
import { redis } from '../lib/redis.js'
import { logger } from '../lib/logger.js'

/**
 * Presence in Redis — TRD §15.2, §12.3.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  PRESENCE IS NEVER PERSISTED — R-SYNC-001.                               │
 * │                                                                          │
 * │  Not to Postgres, not ever. This is Redis with a TTL, which is a cache   │
 * │  that forgets, and forgetting is the feature: a server that dies         │
 * │  mid-session leaves rows behind in a database and ghosts in a room       │
 * │  forever. With a TTL refreshed on every heartbeat, a crashed instance's  │
 * │  sessions simply age out.                                                │
 * │                                                                          │
 * │  If you find yourself writing a cursor position to Postgres, stop.       │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * The in-memory `RoomManager` is the authority for who is connected to THIS
 * instance. This exists for the cross-instance view: with two servers, the
 * room's membership is the union of both processes' maps, and only a shared
 * store can answer that. v1 runs one instance, so today this is written to and
 * mostly read back by the same process — the same argument as the pub/sub
 * fan-out, and the same reason to build it now rather than retrofit it.
 *
 * Every method swallows its own failures. Presence is a nicety; a Redis blip
 * must degrade the avatar stack, never the board.
 */

const key = (boardId: string) => `presence:${boardId}`

/** Seconds. Comfortably longer than the 60 s idle sweep that precedes it. */
const TTL_SECONDS = Math.ceil((PRESENCE_SWEEP_IDLE_MS * 2) / 1000)

export interface PresenceEntry extends PresenceUser {
  /** Epoch ms of the last heartbeat. Drives the stale sweep. */
  seenAt: number
}

export class PresenceService {
  /** Record or refresh a session. Called on join and on every heartbeat. */
  async touch(boardId: string, user: PresenceUser): Promise<void> {
    const entry: PresenceEntry = { ...user, seenAt: Date.now() }
    try {
      const client = redis()
      await client.hset(key(boardId), user.sessionId, JSON.stringify(entry))
      /*
       * The TTL is on the WHOLE hash, refreshed on every touch. Redis has no
       * per-field expiry, so an individual ghost is removed by `forget` and
       * by the sweep; this is the backstop for an instance that dies without
       * running either.
       */
      await client.expire(key(boardId), TTL_SECONDS)
    } catch (error) {
      logger.debug({ err: error, boardId }, 'presence touch failed')
    }
  }

  /**
   * The next round-robin colour slot for a board, shared by EVERY instance
   * (R-UI-013): one counter in Redis, so two people on two processes never
   * draw from separate rotations and land on the same colour. Null when
   * Redis is unreachable — the caller falls back to its own room's rotation.
   */
  async nextColourSlot(boardId: string): Promise<number | null> {
    try {
      const client = redis()
      const key = `presence:colour:${boardId}`
      const slot = await client.incr(key)
      await client.expire(key, 24 * 60 * 60)
      return slot - 1
    } catch (error) {
      logger.debug({ err: error, boardId }, 'colour slot unavailable')
      return null
    }
  }

  async forget(boardId: string, sessionId: string): Promise<void> {
    try {
      await redis().hdel(key(boardId), sessionId)
    } catch (error) {
      logger.debug({ err: error, boardId }, 'presence forget failed')
    }
  }

  /**
   * Everyone currently on the board, across every instance.
   *
   * Stale entries are filtered on READ as well as swept on a timer, because
   * the sweep runs on one instance and a reader on another must not show a
   * ghost in the seconds before it fires.
   */
  async list(boardId: string): Promise<PresenceEntry[]> {
    try {
      const raw = await redis().hgetall(key(boardId))
      const now = Date.now()
      const entries: PresenceEntry[] = []
      for (const value of Object.values(raw)) {
        try {
          const entry = JSON.parse(value) as PresenceEntry
          if (now - entry.seenAt <= PRESENCE_SWEEP_IDLE_MS) entries.push(entry)
        } catch {
          // A malformed field. Skipped rather than failing the whole list.
        }
      }
      return entries
    } catch (error) {
      logger.debug({ err: error, boardId }, 'presence list failed')
      return []
    }
  }

  /**
   * Drop entries idle for over 60 s — R-PERF-023, TRD §12.3.
   *
   * Returns the session ids removed, so the caller can broadcast a
   * `presence_leave` for each: a ghost that vanishes from Redis but stays on
   * everyone's screen has only moved the bug.
   */
  async sweep(boardId: string): Promise<string[]> {
    try {
      const raw = await redis().hgetall(key(boardId))
      const now = Date.now()
      const stale: string[] = []

      for (const [sessionId, value] of Object.entries(raw)) {
        let entry: PresenceEntry | null = null
        try {
          entry = JSON.parse(value) as PresenceEntry
        } catch {
          // Unparseable is stale by definition.
        }
        if (!entry || now - entry.seenAt > PRESENCE_SWEEP_IDLE_MS) stale.push(sessionId)
      }

      if (stale.length > 0) await redis().hdel(key(boardId), ...stale)
      return stale
    } catch (error) {
      logger.debug({ err: error, boardId }, 'presence sweep failed')
      return []
    }
  }

  /** Remove a board's presence entirely. Used when the board is deleted. */
  async clear(boardId: string): Promise<void> {
    try {
      await redis().del(key(boardId))
    } catch (error) {
      logger.debug({ err: error, boardId }, 'presence clear failed')
    }
  }
}

export const presenceService = new PresenceService()
