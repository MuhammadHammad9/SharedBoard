import {
  PRESENCE_SWEEP_IDLE_MS,
  type ObjectId,
  type PresenceUser,
} from '@coboard/shared'
import type { RemoteCursor } from './interpolate.js'

/**
 * Remote presence — cursors, selections, in-flight strokes.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  A PLAIN CLASS, NOT ZUSTAND, AND NOT REACT STATE — R-ARCH-003.           │
 * │                                                                          │
 * │  Cursor positions arrive at 20 Hz PER USER. In a room of ten that is 200 │
 * │  updates a second. Putting them in React state re-renders the tree 200   │
 * │  times a second to move some pixels that React does not draw — the       │
 * │  renderer does, from its own loop, by reading this object directly.      │
 * │                                                                          │
 * │  The header's avatar stack DOES need React, and it subscribes — but only │
 * │  to roster changes (someone joined or left), which happen a few times an │
 * │  hour, not to cursor movement.                                           │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

export interface RemoteStroke {
  sessionId: string
  strokeId: string
  /** Flat [x, y, pressure, …] accumulated from the deltas received so far. */
  points: number[]
  updatedAt: number
}

export interface PresenceSnapshot {
  users: PresenceUser[]
  /** Bumped when the ROSTER changes. Cursor movement does not touch it. */
  version: number
}

type RosterListener = () => void

export class PresenceStore {
  /** Who is in the room, by sessionId. */
  private readonly users = new Map<string, PresenceUser>()
  private readonly cursors = new Map<string, RemoteCursor>()
  private readonly selections = new Map<string, readonly ObjectId[]>()
  private readonly strokes = new Map<string, RemoteStroke>()

  /** Our own session. Never rendered as a remote cursor. */
  private ownSessionId: string | null = null

  private rosterVersion = 0
  private readonly listeners = new Set<RosterListener>()
  private cached: PresenceSnapshot = { users: [], version: 0 }

  setOwnSession(sessionId: string): void {
    this.ownSessionId = sessionId
  }

  get selfSessionId(): string | null {
    return this.ownSessionId
  }

  /* ── Roster ─────────────────────────────────────────────────────────────── */

  replaceRoster(users: readonly PresenceUser[]): void {
    this.users.clear()
    for (const user of users) this.users.set(user.sessionId, user)
    this.bumpRoster()
  }

  join(user: PresenceUser): void {
    this.users.set(user.sessionId, user)
    this.bumpRoster()
  }

  leave(sessionId: string): void {
    const existed = this.users.delete(sessionId)
    // Everything keyed by the session goes with it — R-PERF-023. A cursor left
    // behind by a departed user is a ghost that never moves again.
    this.cursors.delete(sessionId)
    this.selections.delete(sessionId)
    for (const [key, stroke] of this.strokes) {
      if (stroke.sessionId === sessionId) this.strokes.delete(key)
    }
    if (existed) this.bumpRoster()
  }

  user(sessionId: string): PresenceUser | undefined {
    return this.users.get(sessionId)
  }

  /**
   * The roster, for React.
   *
   * `useSyncExternalStore` demands a stable reference between changes, so the
   * snapshot is cached and only rebuilt when the version moves. Returning a
   * fresh array each call is an infinite render loop.
   */
  snapshot(): PresenceSnapshot {
    if (this.cached.version !== this.rosterVersion) {
      this.cached = {
        users: [...this.users.values()].filter(u => u.sessionId !== this.ownSessionId),
        version: this.rosterVersion,
      }
    }
    return this.cached
  }

  subscribe = (listener: RosterListener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private bumpRoster(): void {
    this.rosterVersion += 1
    for (const listener of this.listeners) listener()
  }

  /* ── Cursors ────────────────────────────────────────────────────────────── */

  /**
   * Record a cursor position.
   *
   * The PREVIOUS position is kept so the renderer can interpolate the 50 ms
   * gap between samples. Without it there is nothing to interpolate from and
   * every cursor teleports.
   */
  moveCursor(sessionId: string, x: number, y: number, now = Date.now()): void {
    // Never track our own. Rendering it would put a second pointer a frame
    // behind the real one, and everyone builds this bug once.
    if (sessionId === this.ownSessionId) return

    const existing = this.cursors.get(sessionId)
    this.cursors.set(sessionId, {
      sessionId,
      x,
      y,
      prevX: existing?.x ?? x,
      prevY: existing?.y ?? y,
      updatedAt: now,
    })
  }

  allCursors(): RemoteCursor[] {
    return [...this.cursors.values()]
  }

  /* ── Selection ──────────────────────────────────────────────────────────── */

  setSelection(sessionId: string, ids: readonly ObjectId[]): void {
    if (sessionId === this.ownSessionId) return
    if (ids.length === 0) this.selections.delete(sessionId)
    else this.selections.set(sessionId, ids)
  }

  allSelections(): Array<{ sessionId: string; ids: readonly ObjectId[] }> {
    return [...this.selections].map(([sessionId, ids]) => ({ sessionId, ids }))
  }

  /* ── In-progress strokes ────────────────────────────────────────────────── */

  /**
   * Append a delta to a remote stroke — R-SYNC-041.
   *
   * The sender transmits only the points added since its last send, because a
   * 400-point stroke re-sent whole at 20 Hz is about 100 KB/s per user. The
   * cost of that saving is here: the receiver has to keep the accumulated
   * array and append to it.
   *
   * `done` clears the preview. The committed object arrives separately as an
   * op, so leaving the preview up would double-draw the stroke for one frame.
   */
  appendStroke(
    sessionId: string,
    strokeId: string,
    delta: readonly number[],
    done: boolean,
    now = Date.now(),
  ): void {
    if (sessionId === this.ownSessionId) return

    if (done) {
      this.strokes.delete(strokeId)
      return
    }

    const existing = this.strokes.get(strokeId)
    if (existing) {
      existing.points.push(...delta)
      existing.updatedAt = now
      return
    }
    this.strokes.set(strokeId, {
      sessionId,
      strokeId,
      points: [...delta],
      updatedAt: now,
    })
  }

  allStrokes(): RemoteStroke[] {
    return [...this.strokes.values()]
  }

  /* ── Hygiene ────────────────────────────────────────────────────────────── */

  /**
   * Drop anything stale — R-PERF-023, TRD §12.3.
   *
   * The server sweeps its own Redis entries and broadcasts a leave for each,
   * but a client that missed that broadcast would keep the ghost forever. This
   * is the belt to that braces.
   */
  sweep(now = Date.now()): void {
    for (const [sessionId, cursor] of this.cursors) {
      if (now - cursor.updatedAt > PRESENCE_SWEEP_IDLE_MS) this.cursors.delete(sessionId)
    }
    for (const [id, stroke] of this.strokes) {
      // A stroke preview that has not grown in a minute means its `done` was
      // lost. Dropping it is right: the committed op has long since arrived.
      if (now - stroke.updatedAt > PRESENCE_SWEEP_IDLE_MS) this.strokes.delete(id)
    }
  }

  clear(): void {
    this.users.clear()
    this.cursors.clear()
    this.selections.clear()
    this.strokes.clear()
    this.ownSessionId = null
    this.bumpRoster()
  }
}

/** One store per app, like the board store. */
export const presenceStore = new PresenceStore()
