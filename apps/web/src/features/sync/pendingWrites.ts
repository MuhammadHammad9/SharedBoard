import type { ClientOp } from '@coboard/shared'

/**
 * The local writes the server has not yet ordered — R-CONV-001, R-CONV-006.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  WHY THIS EXISTS.                                                        │
 * │                                                                          │
 * │  The model is server-ordered last-writer-wins PER FIELD. The server      │
 * │  leaves the sender out of the broadcast, so a client never sees its own  │
 * │  op come back in order — it applied it optimistically, at the moment    │
 * │  the user acted.                                                         │
 * │                                                                          │
 * │  Now let B's write to `fill` arrive while A's own write to `fill` is     │
 * │  still unacked. The server will order B's first (it already has a seq)  │
 * │  and A's second, so the true value is A's. Applying B's on arrival       │
 * │  makes A show B's colour while everyone else shows A's: divergence,      │
 * │  permanently, from one click.                                            │
 * │                                                                          │
 * │  So a field with a pending local write is HELD: remote writes to it are  │
 * │  recorded (they are the confirmed value if our write is refused) but     │
 * │  not shown. The ack releases it. This relies on one server property,    │
 * │  TRD §5.4: the sender's ack goes out the moment its op is persisted,    │
 * │  while broadcasts wait for the 16 ms batch — so on any one socket, the   │
 * │  ack for seq N always arrives before the broadcast of anything above N.  │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Pure bookkeeping: no store, no history, no network. The caller applies the
 * ops this returns. That keeps every interleaving testable in isolation, and
 * those interleavings are where convergence bugs live.
 */

/** A field of one object. NUL cannot appear in a uuid or a property name. */
const fieldKey = (objectId: string, field: string): string => `${objectId}\u0000${field}`

interface Tracked {
  op: ClientOp
  /** The op that undoes this one against the CONFIRMED state, when known. */
  inverse: ClientOp | null
  /**
   * Restored from storage after a reload rather than made in this page's
   * lifetime. The server may already hold it, which changes what its ack
   * means — see `PersistenceSession.onAcked`.
   */
  restored: boolean
}

interface Held {
  /** Pending local ops writing this field. */
  count: number
  /** My latest pending value for it — what the server will end with. */
  mine: unknown
  /** The confirmed value under the pending writes, if we know it. */
  base: unknown
  hasBase: boolean
}

export class PendingWrites {
  private readonly ops = new Map<string, Tracked>()
  private readonly held = new Map<string, Held>()
  /**
   * Objects with a pending local CREATE — typically an undo bringing back
   * something deleted. A CREATE replaces the WHOLE object, so every remote op
   * ordered before it (which is every one that arrives while it is pending)
   * is overwritten by it on the server and must not show here either.
   */
  private readonly creating = new Map<string, number>()

  get size(): number {
    return this.ops.size
  }

  has(opId: string): boolean {
    return this.ops.has(opId)
  }

  isRestored(opId: string): boolean {
    return this.ops.get(opId)?.restored ?? false
  }

  typeOf(opId: string): ClientOp | undefined {
    return this.ops.get(opId)?.op
  }

  /**
   * Record ops the user just made.
   *
   * `inverse` is exactly what `buildInverse` returns — reversed, one per op —
   * or null when the batch could not be inverted. Each op's inverse holds the
   * values its fields had BEFORE it, which is the confirmed value whenever
   * the field was not already held.
   */
  track(
    ops: readonly ClientOp[],
    inverse: readonly ClientOp[] | null,
    restored = false,
  ): void {
    ops.forEach((op, i) => {
      if (this.ops.has(op.id)) return
      const inv = inverse ? (inverse[ops.length - 1 - i] ?? null) : null
      this.ops.set(op.id, { op, inverse: inv, restored })
      if (op.type === 'CREATE') {
        this.creating.set(op.objectId, (this.creating.get(op.objectId) ?? 0) + 1)
        return
      }
      if (op.type !== 'UPDATE') return

      const before = (inv?.type === 'UPDATE' ? inv.payload : null) as Record<
        string,
        unknown
      > | null
      for (const field of Object.keys(op.payload)) {
        const key = fieldKey(op.objectId, field)
        const value = (op.payload as Record<string, unknown>)[field]
        const held = this.held.get(key)
        if (held) {
          held.count += 1
          held.mine = value
          continue
        }
        this.held.set(key, {
          count: 1,
          mine: value,
          base: before?.[field],
          hasBase: before !== null && field in before,
        })
      }
    })
  }

  /** The server stored it. Its fields are released. */
  ack(opId: string): void {
    this.release(opId)
  }

  /**
   * The local document must go back to what the server has — a nack, or a
   * restored op the server turns out to have stored long ago.
   *
   * Returns LOCAL ops that restore the confirmed state, for fields no other
   * pending op still holds. A field another pending write holds is left as
   * it is: that later write is what the server will end up with.
   */
  revert(opId: string): ClientOp[] {
    const tracked = this.ops.get(opId)
    if (!tracked) return []
    const { op, inverse } = tracked
    const restore: ClientOp[] = []

    switch (op.type) {
      case 'CREATE':
        /*
         * The object never existed on the server. The delete carries seq 0 so
         * its tombstone loses to anything the server ever sends — it must not
         * become the permanent local tombstone a plain local DELETE leaves.
         */
        restore.push({
          id: `revert:${op.id}`,
          type: 'DELETE',
          objectId: op.objectId,
          payload: {},
          seq: 0,
        } as ClientOp)
        break

      case 'DELETE':
        if (inverse) restore.push({ ...inverse, id: `revert:${op.id}` })
        break

      case 'UPDATE': {
        const payload: Record<string, unknown> = {}
        for (const field of Object.keys(op.payload)) {
          const held = this.held.get(fieldKey(op.objectId, field))
          if (held && held.count === 1 && held.hasBase) payload[field] = held.base
        }
        if (Object.keys(payload).length > 0) {
          restore.push({
            id: `revert:${op.id}`,
            type: 'UPDATE',
            objectId: op.objectId,
            payload,
          })
        }
        break
      }
    }

    this.release(opId)
    return restore
  }

  /**
   * Hold back the parts of a remote op that touch held fields.
   *
   * Returns the op to apply — possibly with a smaller payload — or null when
   * nothing of it is left. A DELETE passes unless the object has a pending
   * local CREATE: delete wins (R-CONV-003) over everything ordered before it,
   * and nothing else.
   */
  filterRemote<T extends ClientOp>(op: T): T | null {
    /*
     * My CREATE is still unordered, so the server will apply it AFTER this op
     * — whatever this op is. Even a DELETE: delete-wins means a delete ordered
     * before a re-create loses to it, and applying it here would leave this
     * client without an object everyone else has.
     */
    if (this.creating.has(op.objectId)) return null
    if (this.held.size === 0) return op
    if (op.type === 'CREATE') return this.overlayMine(op)
    if (op.type !== 'UPDATE') return op

    let payload: Record<string, unknown> | null = null
    for (const [field, value] of Object.entries(op.payload)) {
      const held = this.held.get(fieldKey(op.objectId, field))
      if (!held) continue
      // The newest confirmed value, should our write be refused.
      held.base = value
      held.hasBase = true
      payload ??= { ...op.payload }
      delete payload[field]
    }

    if (payload === null) return op
    return Object.keys(payload).length > 0 ? { ...op, payload } : null
  }

  /**
   * The document was replaced by a fresh snapshot. Its values are now the
   * confirmed ones under every held field.
   */
  rebase(read: (objectId: string) => Record<string, unknown> | undefined): void {
    for (const [key, held] of this.held) {
      const [objectId, field] = key.split('\u0000') as [string, string]
      const object = read(objectId)
      held.hasBase = object !== undefined && field in object
      held.base = object?.[field]
    }
  }

  /** Treat these as re-applied over a freshly loaded document. */
  markRestored(opIds: readonly string[]): void {
    for (const id of opIds) {
      const tracked = this.ops.get(id)
      if (tracked) tracked.restored = true
    }
  }

  /** Every tracked op, in the order it was made. */
  tracked(): ClientOp[] {
    return [...this.ops.values()].map(t => t.op)
  }

  /**
   * A remote CREATE — someone's undo bringing an object back — replaces the
   * whole object, and it is ordered BEFORE my pending writes to it. So my
   * values stay on top, and its values become the confirmed base under them.
   */
  private overlayMine<T extends ClientOp>(op: T): T {
    const prefix = `${op.objectId}\u0000`
    let payload: Record<string, unknown> | null = null
    for (const [key, held] of this.held) {
      if (!key.startsWith(prefix)) continue
      const field = key.slice(prefix.length)
      payload ??= { ...(op.payload as Record<string, unknown>) }
      held.hasBase = field in payload
      held.base = payload[field]
      payload[field] = held.mine
    }
    return payload === null ? op : { ...op, payload }
  }

  clear(): void {
    this.ops.clear()
    this.held.clear()
    this.creating.clear()
  }

  private release(opId: string): void {
    const tracked = this.ops.get(opId)
    if (!tracked) return
    this.ops.delete(opId)
    if (tracked.op.type === 'CREATE') {
      const n = (this.creating.get(tracked.op.objectId) ?? 0) - 1
      if (n <= 0) this.creating.delete(tracked.op.objectId)
      else this.creating.set(tracked.op.objectId, n)
      return
    }
    if (tracked.op.type !== 'UPDATE') return
    for (const field of Object.keys(tracked.op.payload)) {
      const key = fieldKey(tracked.op.objectId, field)
      const held = this.held.get(key)
      if (!held) continue
      held.count -= 1
      if (held.count <= 0) this.held.delete(key)
    }
  }
}
