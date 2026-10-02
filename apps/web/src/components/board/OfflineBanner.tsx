import { useEffect, useState } from 'react'
import {
  OFFLINE_WARNING_MS,
  OUTBOX_WARNING_THRESHOLD,
  type ConnectionState,
} from '@coboard/shared'
import { presence } from '../../lib/strings.js'

/**
 * "You've been offline a while…" — FLOWS §9.4, P11-T10.
 *
 * Shown once the connection has been down for 10 minutes, or the unsent
 * changes pass 500, whichever comes first. Nothing is lost at that point —
 * the outbox is on disk — but a long absence means the board may have moved
 * a lot underneath, and a refresh once back online is the honest advice.
 *
 * Not dismissible and not a toast: it describes a condition that is still
 * true, and it leaves the moment the condition does.
 */

const isDown = (state: ConnectionState) => state === 'reconnecting' || state === 'offline'

/** Pure, for the tests. */
export function shouldWarnOffline(downForMs: number, pending: number): boolean {
  return downForMs >= OFFLINE_WARNING_MS || pending >= OUTBOX_WARNING_THRESHOLD
}

export function OfflineBanner({
  state,
  pending,
  now = Date.now,
}: {
  state: ConnectionState
  pending: number
  now?: () => number
}) {
  const down = isDown(state)
  const [downSince, setDownSince] = useState<number | null>(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    setDownSince(down ? now() : null)
  }, [down, now])

  // Re-check the clock while down. Once a minute is plenty for a 10-minute rule.
  useEffect(() => {
    if (!down) return
    const id = setInterval(() => setTick(t => t + 1), 60_000)
    return () => clearInterval(id)
  }, [down])

  if (!down || downSince === null) return null
  if (!shouldWarnOffline(now() - downSince, pending)) return null

  return (
    <div
      role="alert"
      data-offline-banner
      data-testid="offline-banner"
      className="pointer-events-auto absolute left-1/2 top-16 z-header max-w-[36rem] -translate-x-1/2 rounded-md border border-border bg-app px-4 py-2 text-sm text-primary shadow-panel"
    >
      {presence.offlineAWhile}
    </div>
  )
}
