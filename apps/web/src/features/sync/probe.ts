import type { ConnectionState } from '@coboard/shared'
import { boardStore } from '../../stores/boardStore.js'
import { stateHash } from './stateHash.js'

/**
 * A read-only window onto the live sync session, for the `?debug=1` panel and
 * the convergence e2e harness — R-CONV-011.
 *
 * The board session registers itself here on start and clears itself on
 * dispose. Nothing reads through this to make a decision; it exists so that
 * the two numbers that prove convergence — `lastAppliedSeq` and the state
 * hash — can be compared across two windows without opening the console.
 */

export interface SyncProbe {
  appliedSeq: () => number
  pendingOps: () => number
  connection: () => ConnectionState
}

export interface SyncReading {
  seq: number
  pending: number
  connection: ConnectionState
  objects: number
  hash: string
}

let probe: SyncProbe | null = null

export function setSyncProbe(next: SyncProbe | null): void {
  probe = next
}

/** Null when no board session is live — a scratch board, or mid-teardown. */
export function readSync(): SyncReading | null {
  if (!probe) return null
  const { objects } = boardStore.getState()
  return {
    seq: probe.appliedSeq(),
    pending: probe.pendingOps(),
    connection: probe.connection(),
    objects: objects.size,
    hash: stateHash(objects.values()),
  }
}

/*
 * The e2e harness reads the same numbers the panel shows, through a function
 * rather than by scraping text on a polling interval — scraping would race the
 * panel's own refresh. Development builds only; production never carries it.
 */
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __coboardSync?: () => SyncReading | null }).__coboardSync =
    readSync
}
