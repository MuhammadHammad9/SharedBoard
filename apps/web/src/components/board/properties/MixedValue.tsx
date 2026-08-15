/**
 * "Mixed" — FLOWS §14.4.
 *
 * Shown when a multi-selection's members disagree on a property. The
 * alternative, showing the first object's value, is actively harmful: the
 * panel would claim the whole selection is black when only one object is, and
 * the user would have no way to tell without deselecting and checking each.
 */
export function MixedValue() {
  return (
    <span className="text-xs italic text-muted" data-testid="mixed-value">
      Mixed
    </span>
  )
}

/**
 * Collapse a property across a selection.
 *
 * Returns the shared value, or the `MIXED` sentinel when the members disagree.
 * A sentinel rather than `undefined` because "they disagree" and "nobody has
 * one" are different states that render differently.
 */
export const MIXED = Symbol('mixed')

export function commonValue<T, V>(
  items: readonly T[],
  read: (item: T) => V | undefined,
): V | undefined | typeof MIXED {
  if (items.length === 0) return undefined
  const first = read(items[0]!)
  for (let i = 1; i < items.length; i++) {
    if (read(items[i]!) !== first) return MIXED
  }
  return first
}
