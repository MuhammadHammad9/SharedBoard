import { useEffect, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { ERROR_CODES } from '@coboard/shared'
import { useToast } from '../components/ui/Toast.js'
import { FullScreenSpinner } from '../components/ui/Spinner.js'
import { api, ApiError } from '../lib/api.js'
import { verifyEmail as copy } from '../lib/strings.js'

/**
 * `/verify-email?token=` — D-22.
 *
 * The link from the verification email. Board invites are claimed only for a
 * proven address, and opening this link is the proof: the server marks the
 * address verified and THEN claims the invites. Either way the user lands on
 * the dashboard, told what happened in a toast; a logged-out user is sent on
 * to log in by the dashboard's own guard, with the toast still showing.
 *
 * Guarded by the token in the URL, not by a session, like /reset-password.
 */
export default function VerifyEmail() {
  const [params] = useSearchParams()
  const token = params.get('token')
  const navigate = useNavigate()
  const toast = useToast()
  // The token is single-use: StrictMode's double effect must not spend it twice.
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true

    void (async () => {
      try {
        if (!token) throw new ApiError(ERROR_CODES.TOKEN_INVALID, 'Missing token', 400)
        await api.post<{ ok: true; claimed: number }>('/auth/verify-email', { token })
        toast.show({ message: copy.verified })
      } catch (err) {
        const code = err instanceof ApiError ? err.code : null
        toast.show({
          message:
            code === ERROR_CODES.TOKEN_EXPIRED
              ? copy.expired
              : code === ERROR_CODES.TOKEN_USED
                ? copy.used
                : code === ERROR_CODES.TOKEN_INVALID
                  ? copy.invalid
                  : copy.failed,
          variant: 'danger',
        })
      }
      navigate('/dashboard', { replace: true })
    })()
  }, [token, navigate, toast])

  return <FullScreenSpinner label={copy.checking} />
}
