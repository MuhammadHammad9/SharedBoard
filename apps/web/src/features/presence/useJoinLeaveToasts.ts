import { useEffect, useRef } from 'react'
import { presence as presenceStrings } from '../../lib/strings.js'
import { useToast } from '../../components/ui/Toast.js'
import { dedupeByUser } from './AvatarStack.js'
import { useRoster } from './usePresence.js'

/**
 * "Marcus joined" / "Marcus left" — `FR-RT-008`, FLOWS §9.1.
 *
 * Derived from roster DIFFS rather than from the socket messages directly, and
 * that is what makes E-01 come out right: a person opening a second tab
 * produces a `presence_join` but no change in the deduped roster, so no toast.
 * Announcing "Marcus joined" when Marcus has been here for an hour is the kind
 * of small wrongness that makes a room feel unreliable.
 *
 * Three seconds, and the roster is compared on every change rather than
 * tracked incrementally — a handful of names diffed a few times an hour is
 * nothing, and incremental tracking is where the double-toast bugs live.
 */

const TOAST_MS = 3_000

export function useJoinLeaveToasts(): void {
  const { users } = useRoster()
  const toast = useToast()
  const previous = useRef<Map<string, string> | null>(null)

  useEffect(() => {
    const current = new Map(
      dedupeByUser(users).map(u => [u.userId ?? `guest:${u.sessionId}`, u.name]),
    )

    /*
     * The FIRST roster is the people already here when we arrived, and they
     * did not just join. Toasting them would greet the user with three
     * notifications about a room they have only this moment entered.
     */
    if (previous.current === null) {
      previous.current = current
      return
    }

    const before = previous.current
    for (const [key, name] of current) {
      if (!before.has(key)) toast.show({ message: presenceStrings.userJoined(name), durationMs: TOAST_MS })
    }
    for (const [key, name] of before) {
      if (!current.has(key)) toast.show({ message: presenceStrings.userLeft(name), durationMs: TOAST_MS })
    }

    previous.current = current
  }, [users, toast])
}
