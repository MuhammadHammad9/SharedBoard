import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing'
import type { BoardObject, ObjectId } from '@coboard/shared'

/**
 * Fractional z-indexing — TRD §6.4, decision `D-8`, `FR-CANVAS-016`.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  WHY NOT AN INTEGER                                                      │
 * │                                                                          │
 * │  Inserting between two integer-indexed objects means renumbering every   │
 * │  object above the insertion point. On a 5,000-object board that is 5,000 │
 * │  UPDATE ops for one "bring forward" — an op storm that saturates the     │
 * │  socket, and one that CONFLICTS with every other user's reorder because  │
 * │  they all rewrite the same fields.                                       │
 * │                                                                          │
 * │  A fractional key is a string ordered lexicographically, and there is    │
 * │  always room between any two of them: "a0" and "a1" admit "a0V". One     │
 * │  object moves, one op is emitted, and two users reordering at the same   │
 * │  time produce two distinct valid keys rather than a conflict.            │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * The `fractional-indexing` package rather than a hand-rolled midpoint: the
 * base-62 digit handling and the "shorter key sorts first" edge cases are
 * fiddly, and getting them subtly wrong produces an ordering that is stable
 * for weeks and then is not.
 *
 * NOTE ON THE PHASE 1-8 FORMAT. Objects created before this phase, and the
 * committed stress fixture, use `a` + six base-36 digits — `a000042`. Those
 * are valid fractional keys as far as ordering is concerned: they are plain
 * strings compared lexicographically, and `generateKeyBetween` accepts them as
 * bounds. No migration is needed, and none is wanted: rewriting 10,000 zIndex
 * values would be 10,000 ops to change nothing anyone can see.
 */

/** The key for a new object placed on top of everything. */
export function keyAfterTop(objects: ReadonlyMap<ObjectId, BoardObject>, sortedIds: readonly ObjectId[]): string {
  const topId = sortedIds[sortedIds.length - 1]
  const top = topId ? objects.get(topId) : undefined
  return generateKeyBetween(top?.zIndex ?? null, null)
}

/** N keys above everything, in order. A paste of several objects. */
export function keysAfterTop(
  objects: ReadonlyMap<ObjectId, BoardObject>,
  sortedIds: readonly ObjectId[],
  count: number,
): string[] {
  if (count <= 0) return []
  const topId = sortedIds[sortedIds.length - 1]
  const top = topId ? objects.get(topId) : undefined
  return generateNKeysBetween(top?.zIndex ?? null, null, count)
}

/** N keys below everything, in order. "Send to back". */
export function keysBeforeBottom(
  objects: ReadonlyMap<ObjectId, BoardObject>,
  sortedIds: readonly ObjectId[],
  count: number,
): string[] {
  if (count <= 0) return []
  const bottomId = sortedIds[0]
  const bottom = bottomId ? objects.get(bottomId) : undefined
  return generateNKeysBetween(null, bottom?.zIndex ?? null, count)
}

/**
 * One step up: keys placing the selection just above `reference`.
 *
 * The neighbour above the reference is the upper bound, so the result lands
 * strictly between them and nothing else has to move — which is the entire
 * argument for fractional indexing over renumbering.
 */
export function keysAfter(
  objects: ReadonlyMap<ObjectId, BoardObject>,
  sortedIds: readonly ObjectId[],
  referenceIndex: number,
  count: number,
): string[] {
  const lower = objects.get(sortedIds[referenceIndex] as ObjectId)?.zIndex ?? null
  const upperId = sortedIds[referenceIndex + 1]
  const upper = upperId ? (objects.get(upperId)?.zIndex ?? null) : null
  return generateNKeysBetween(lower, upper, count)
}

export function keysBefore(
  objects: ReadonlyMap<ObjectId, BoardObject>,
  sortedIds: readonly ObjectId[],
  referenceIndex: number,
  count: number,
): string[] {
  const upper = objects.get(sortedIds[referenceIndex] as ObjectId)?.zIndex ?? null
  const lowerId = sortedIds[referenceIndex - 1]
  const lower = lowerId ? (objects.get(lowerId)?.zIndex ?? null) : null
  return generateNKeysBetween(lower, upper, count)
}
