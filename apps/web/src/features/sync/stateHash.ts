import type { BoardObject } from '@coboard/shared'

/**
 * The convergence oracle — TRD §6.5, R-CONV-011.
 *
 * Two clients on the same board at the same `lastAppliedSeq` must produce the
 * same string here. If they do not, one of them has applied something the
 * other has not, or applied it differently, and the hash says so long before
 * a user notices a sticky note in the wrong place.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  STABLE MEANS INDEPENDENT OF EVERYTHING THAT IS NOT THE DOCUMENT.        │
 * │                                                                          │
 * │  • Map insertion order — a client that loaded a snapshot and one that   │
 * │    watched every op arrive hold the same objects in different orders.   │
 * │    Objects are sorted by id.                                             │
 * │  • Key order — `{ ...before, ...payload }` puts a changed key wherever  │
 * │    the spread left it. Keys are sorted at every depth.                   │
 * │  • Float noise — a resize computed on two machines can disagree in the  │
 * │    15th digit. Numbers are rounded to 2 dp, and -0 is 0.                 │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * It is a debug and test tool, not a security primitive: cyrb53 is fast and
 * spreads well, and a 53-bit collision between two diverged boards is not a
 * scenario worth a cryptographic hash.
 */

export function stateHash(objects: Iterable<BoardObject>): string {
  const sorted = [...objects].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return cyrb53(canonical(sorted))
}

/** JSON with sorted keys and rounded numbers. Exported for the tests. */
export function canonical(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null'
    const rounded = Math.round(value * 100) / 100
    // `Object.is(-0, 0)` is false and `String(-0)` is "0", but rounding can
    // produce -0 from a tiny negative, so normalise explicitly.
    return String(rounded === 0 ? 0 : rounded)
  }
  if (value === null || typeof value !== 'object') {
    return value === undefined ? 'null' : JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`

  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
    // An absent key and an `undefined` one are the same document.
    .filter(k => record[k] !== undefined)
    .sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(record[k])}`).join(',')}}`
}

/** cyrb53 — a 53-bit non-cryptographic string hash, as 14 hex digits. */
function cyrb53(input: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0)
  return n.toString(16).padStart(14, '0')
}
