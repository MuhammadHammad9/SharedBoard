import { useEffect, useState } from 'react'
import type { PublicUser } from '@coboard/shared'
import { api, attemptSilentRefresh, setGuestCredential } from '../../lib/api.js'
import { getAccessToken, useAuthStore } from '../../stores/authStore.js'
import {
  clearGuest,
  onAccountCreated,
  type GuestIdentity,
} from '../auth/guestIdentity.js'
import { claimGuestSeat } from './api.js'

/**
 * Guest → account, in place — FLOWS §7.4.
 *
 *   the signup tab announces ACCOUNT_CREATED_MESSAGE (email or Google)
 *     → pick up the new session (the refresh cookie is shared)
 *     → the account takes over the guest's seat, as an Editor
 *     → forget the guest identity; reconnect the socket as the account
 *
 * NOTHING on the canvas is touched: the document, the outbox and the applied
 * seq all stay. The socket's rejoin replays nothing the board does not have,
 * the presence entry comes back under the account's name, and the guest bar
 * goes away because there is no guest any more.
 *
 * Returns the guest still being acted as, or null once upgraded.
 */
export function useGuestConversion(
  boardId: string,
  initial: GuestIdentity | null,
  reconnect: () => void,
): GuestIdentity | null {
  const [guest, setGuest] = useState(initial)

  useEffect(() => {
    if (!guest) return
    let busy = false

    const upgrade = async () => {
      if (busy) return
      busy = true
      try {
        if (!(await attemptSilentRefresh())) return
        const { user } = await api.get<{ user: PublicUser }>('/auth/me')
        useAuthStore.getState().setSession(user, getAccessToken() ?? '')
        await claimGuestSeat(boardId, guest.id)
        clearGuest()
        setGuestCredential(null)
        setGuest(null)
        reconnect()
      } catch {
        // Left as a guest: nothing is lost, and the bar is still there.
      } finally {
        busy = false
      }
    }

    // Both routes may deliver; `busy` and the guest clearing make it once.
    return onAccountCreated(() => void upgrade())
  }, [boardId, guest, reconnect])

  return guest
}
