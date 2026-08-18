import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import type { PublicUser } from '@coboard/shared'
import { api, attemptSilentRefresh } from '../lib/api.js'
import { useAuthStore, getAccessToken } from '../stores/authStore.js'
import { OAUTH_NEXT_KEY } from '../features/auth/api.js'
import { FullScreenSpinner } from '../components/ui/Spinner.js'
import { auth } from '../lib/strings.js'
import { safeNext } from './nextParam.js'

/**
 * S-06 OAuth callback — FLOWS §3.3.
 *
 * "S-06 must never be a screen the user sees for more than ~1 second. If it
 * exceeds 5 seconds, show 'Still working…' and after 15 seconds fail over to
 * S-03 with an error."
 *
 * By the time the browser lands here the server has already exchanged the
 * code and set the refresh cookie, so all this screen does is trade that
 * cookie for an access token and find out who the user is. The two timers are
 * the interesting part: a spinner with no upper bound is how an OAuth flow
 * becomes a permanently hung tab.
 */

const STILL_WORKING_MS = 5_000
const GIVE_UP_MS = 15_000

export default function OAuthCallback() {
  const navigate = useNavigate()
  const setSession = useAuthStore(s => s.setSession)
  const clear = useAuthStore(s => s.clear)
  const [slow, setSlow] = useState(false)

  useEffect(() => {
    let done = false

    const slowTimer = setTimeout(() => {
      if (!done) setSlow(true)
    }, STILL_WORKING_MS)

    const giveUpTimer = setTimeout(() => {
      if (done) return
      done = true
      clear()
      navigate('/login?error=oauth', { replace: true })
    }, GIVE_UP_MS)

    void (async () => {
      try {
        const refreshed = await attemptSilentRefresh()
        if (done) return

        if (!refreshed) {
          done = true
          clear()
          navigate('/login?error=oauth', { replace: true })
          return
        }

        const { user } = await api.get<{ user: PublicUser }>('/auth/me')
        if (done) return
        done = true
        setSession(user, getAccessToken() ?? '')

        // The deep link stashed before we left for Google. Validated the same
        // way as any other `next`, because sessionStorage is writable by any
        // script on the origin.
        let next: string | null = null
        try {
          next = sessionStorage.getItem(OAUTH_NEXT_KEY)
          sessionStorage.removeItem(OAUTH_NEXT_KEY)
        } catch {
          // E-18: storage blocked. Fall through to the dashboard.
        }
        navigate(safeNext(next), { replace: true })
      } catch {
        if (done) return
        done = true
        clear()
        navigate('/login?error=oauth', { replace: true })
      }
    })()

    return () => {
      done = true
      clearTimeout(slowTimer)
      clearTimeout(giveUpTimer)
    }
  }, [navigate, setSession, clear])

  return (
    <FullScreenSpinner
      label={slow ? auth.callback.stillWorking : auth.callback.signingIn}
    />
  )
}
