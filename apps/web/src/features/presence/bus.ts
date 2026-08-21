import type { ObjectId } from '@coboard/shared'
import type { PresenceEmitter } from './send.js'

/**
 * The presence send seam.
 *
 * The same shape as `emitOps` in `features/sync/persistence.ts`, and for the
 * same reason: the canvas emits presence without knowing whether a board
 * session exists. With no session — the Phase 2-6 canvas suites, a scratch
 * board, `pnpm dev` before signing in — every call is a no-op and the canvas
 * behaves exactly as it did before Phase 10.
 *
 * A module variable rather than context because the callers are pointer
 * handlers running at 240 Hz outside React (R-ARCH-002); reaching them through
 * a provider would mean either prop-drilling into the interaction layer or
 * re-rendering it.
 */

let emitter: PresenceEmitter | null = null

export function setPresenceEmitter(next: PresenceEmitter | null): void {
  emitter = next
}

export const emitCursor = (x: number, y: number): void => emitter?.cursor(x, y)

export const emitSelection = (ids: readonly ObjectId[]): void => emitter?.selection(ids)

export const emitStrokeProgress = (strokeId: string, points: readonly number[]): void =>
  emitter?.strokeProgress(strokeId, points)

export const emitStrokeDone = (strokeId: string): void => emitter?.strokeDone(strokeId)
