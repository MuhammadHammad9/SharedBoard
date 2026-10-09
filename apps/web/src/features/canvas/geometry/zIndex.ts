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

/**
 * The ONE paint order: zIndex, then id.
 *
 * Two people creating at the same moment both take "the key above the top"
 * from the same document and get the SAME key. Ordered by key alone, the tie
 * falls to insertion order, which differs per client — the same board then
 * paints differently on each screen. The id is the same everywhere, so it is
 * the tie-break everywhere order is decided (R-CONV-009).
 */
export function compareZ(
  a: Pick<BoardObject, 'zIndex' | 'id'>,
  b: Pick<BoardObject, 'zIndex' | 'id'>,
): number {
  if (a.zIndex < b.zIndex) return -1
  if (a.zIndex > b.zIndex) return 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** The key for a new object placed on top of everything. */
export function keyAfterTop(
  objects: ReadonlyMap<ObjectId, BoardObject>,
  sortedIds: readonly ObjectId[],
): string {
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
 *
 * "The neighbour" is the next STRICTLY greater key. Neighbours can share the
 * reference's key (concurrent creates — see `compareZ`), and asking for keys
 * between `a` and `a` throws.
 */
export function keysAfter(
  objects: ReadonlyMap<ObjectId, BoardObject>,
  sortedIds: readonly ObjectId[],
  referenceIndex: number,
  count: number,
): string[] {
  const lower = objects.get(sortedIds[referenceIndex] as ObjectId)?.zIndex ?? null
  let upper: string | null = null
  for (let i = referenceIndex + 1; i < sortedIds.length; i++) {
    const z = objects.get(sortedIds[i]!)?.zIndex
    if (z !== undefined && (lower === null || z > lower)) {
      upper = z
      break
    }
  }
  return generateNKeysBetween(lower, upper, count)
}

/** One step down: keys placing the selection just below `reference`. */
export function keysBefore(
  objects: ReadonlyMap<ObjectId, BoardObject>,
  sortedIds: readonly ObjectId[],
  referenceIndex: number,
  count: number,
): string[] {
  const upper = objects.get(sortedIds[referenceIndex] as ObjectId)?.zIndex ?? null
  let lower: string | null = null
  for (let i = referenceIndex - 1; i >= 0; i--) {
    const z = objects.get(sortedIds[i]!)?.zIndex
    if (z !== undefined && (upper === null || z < upper)) {
      lower = z
      break
    }
  }
  return generateNKeysBetween(lower, upper, count)
}
