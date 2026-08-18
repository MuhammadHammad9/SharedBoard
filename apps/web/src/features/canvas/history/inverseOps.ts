import type { BoardObject, ClientOp, ObjectId } from '@coboard/shared'

/**
 * Inverse-op construction — TRD §8.2, R-UNDO-007.
 *
 * | Forward                     | Inverse                                    |
 * | --------------------------- | ------------------------------------------ |
 * | CREATE(obj)                 | DELETE(obj.id)                             |
 * | DELETE(obj)                 | CREATE(snapshot taken BEFORE the deletion) |
 * | UPDATE(id, {fill:'red'})    | UPDATE(id, {fill: <previous value>})       |
 *
 * PRD risk R-3 is High/High and its instruction is blunt: implement TRD §8
 * exactly, do not invent a variant. So this file is a transcription, not a
 * design.
 *
 * The one thing everyone gets wrong is the ordering: **the previous values
 * must be read before the forward op is applied.** `buildInverse` therefore
 * takes a reader for the CURRENT store and is only ever called from
 * `applyAndEmit`, before it mutates. Making that the single call site is what
 * stops the rule being forgotten at the twelfth call site six phases from now.
 */

/** Reads the store as it is right now. Supplied by the caller, pre-mutation. */
export type ObjectReader = (id: ObjectId) => BoardObject | undefined

const opId = (): string => crypto.randomUUID()

export const createOp = (object: BoardObject): ClientOp => ({
  id: opId(),
  type: 'CREATE',
  objectId: object.id,
  payload: object,
})

export const updateOp = (id: ObjectId, changes: Record<string, unknown>): ClientOp => ({
  id: opId(),
  type: 'UPDATE',
  objectId: id,
  payload: changes,
})

export const deleteOp = (id: ObjectId): ClientOp => ({
  id: opId(),
  type: 'DELETE',
  objectId: id,
  payload: {},
})

/**
 * The inverse of one op, given the store as it stands BEFORE that op applies.
 *
 * Returns null when the op cannot be inverted — an UPDATE or DELETE naming an
 * object that is not there. A null is dropped rather than guessed at: an
 * inverse built from a missing object would restore something that never
 * existed in that form.
 */
export function invertOp(op: ClientOp, read: ObjectReader): ClientOp | null {
  switch (op.type) {
    case 'CREATE':
      return deleteOp(op.objectId as ObjectId)

    case 'DELETE': {
      // The FULL object, snapshotted before it goes. Anything less and undo
      // restores a husk.
      const before = read(op.objectId as ObjectId)
      return before ? createOp(before) : null
    }

    case 'UPDATE': {
      const before = read(op.objectId as ObjectId)
      if (!before) return null

      /*
       * ONLY the keys being changed — R-UNDO-007, TRD §8.2.
       *
       * This is what keeps undo from clobbering a teammate's concurrent edit
       * to a DIFFERENT field. Inverting the whole object would mean undoing a
       * colour change also reverts the position someone else just moved it to,
       * and the two users would fight over one object forever.
       */
      const inverseChanges: Record<string, unknown> = {}
      for (const key of Object.keys(op.payload)) {
        inverseChanges[key] = (before as unknown as Record<string, unknown>)[key]
      }
      return updateOp(op.objectId as ObjectId, inverseChanges)
    }
  }
}

/**
 * An UPDATE op carrying only the keys that actually changed between two
 * versions of an object.
 *
 * The gestures that mutate live — drag, resize, rotate — replace the whole
 * object on every pointermove, so by `pointerup` the store holds a completely
 * new object and there is no record of which fields moved. Diffing against the
 * pointerdown snapshot recovers exactly that, and recovers it as the minimal
 * key set R-UNDO-007 requires rather than as a whole-object write that would
 * clobber a teammate's concurrent edit to an untouched field.
 *
 * Returns null when nothing changed — a click that never became a drag must
 * not leave an undo entry behind.
 */
export function diffOp(before: BoardObject, after: BoardObject): ClientOp | null {
  const changes: Record<string, unknown> = {}
  const b = before as unknown as Record<string, unknown>
  const a = after as unknown as Record<string, unknown>

  let changed = false
  for (const key of Object.keys(a)) {
    if (sameValue(b[key], a[key])) continue
    changes[key] = a[key]
    // `updatedAt` is a timestamp every transform rewrites, so on its own it is
    // not evidence that anything moved. It rides along when something else did.
    if (key !== 'updatedAt') changed = true
  }

  return changed ? updateOp(after.id, changes) : null
}

/**
 * Value equality for the diff. Element-wise on arrays because a stroke's
 * `points` array is rebuilt on every transform: a reference compare would
 * report every stroke as changed on a gesture that only touched its neighbour.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Invert a batch, preserving the reversal order.
 *
 * Reversed because undoing a sequence means undoing its last step first: if a
 * paste created A then B, the inverse must delete B then A. For independent
 * ops the order is immaterial; for dependent ones it is the difference between
 * a correct undo and a broken one.
 *
 * Returns null when ANY op cannot be inverted — a partial inverse would leave
 * the board in a state the user never occupied, which is worse than declining
 * to record the entry at all.
 */
export function buildInverse(
  ops: readonly ClientOp[],
  read: ObjectReader,
): ClientOp[] | null {
  const out: ClientOp[] = []
  for (let i = ops.length - 1; i >= 0; i--) {
    const inverse = invertOp(ops[i]!, read)
    if (!inverse) return null
    out.push(inverse)
  }
  return out
}
