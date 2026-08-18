import { useEffect, useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { ERROR_CODES } from '@coboard/shared'
import { AuthLayout } from '../features/auth/AuthLayout.js'
import { PasswordStrength, checkPassword } from '../features/auth/PasswordStrength.js'
import { useForm } from '../features/auth/useForm.js'
import { resetPassword, validateResetToken } from '../features/auth/api.js'
import { ApiError, NETWORK_ERROR_CODE } from '../lib/api.js'
import { Button } from '../components/ui/Button.js'
import { FormError } from '../components/ui/FormError.js'
import { Input } from '../components/ui/Input.js'
import { FullScreenSpinner } from '../components/ui/Spinner.js'
import { auth, validation } from '../lib/strings.js'

/**
 * S-05 Reset password — FR-AUTH-004, FLOWS §5.
 *
 * The token is validated ON MOUNT, before the form renders. Letting the user
 * type a new password and only then discovering the link expired an hour ago
 * wastes their effort at the exact moment they are already locked out and
 * frustrated.
 *
 * Three failure states, each with its own banner, because "invalid" and
 * "expired" and "already used" call for different reactions: one means the
 * link is corrupt, one means it is stale, one means it worked and they are
 * probably already done.
 */

type TokenState = 'checking' | 'valid' | 'invalid' | 'expired' | 'used'

const BANNER: Record<Exclude<TokenState, 'checking' | 'valid'>, string> = {
  invalid: auth.reset.invalid,
  expired: auth.reset.expired,
  used: auth.reset.used,
}

export default function ResetPassword() {
  const [params] = useSearchParams()
  const token = params.get('token')
  const navigate = useNavigate()
  const [tokenState, setTokenState] = useState<TokenState>('checking')

  const form = useForm({ password: '', confirm: '' }, values => ({
    password: Object.values(checkPassword(values.password)).every(Boolean)
      ? undefined
      : validation.passwordRules,
    confirm:
      values.confirm.length === 0
        ? validation.passwordRequired
        : values.confirm === values.password
          ? undefined
          : auth.reset.mismatch,
  }))

  useEffect(() => {
    if (!token) return
    let cancelled = false

    void (async () => {
      try {
        await validateResetToken(token)
        if (!cancelled) setTokenState('valid')
      } catch (err) {
        if (cancelled) return
        const code = err instanceof ApiError ? err.code : null
        setTokenState(
          code === ERROR_CODES.TOKEN_EXPIRED
            ? 'expired'
            : code === ERROR_CODES.TOKEN_USED
              ? 'used'
              : 'invalid',
        )
      }
    })()

    return () => {
      cancelled = true
    }
  }, [token])

  // FLOWS §2.1: the route requires a token; without one there is nothing to
  // reset, so it belongs back at the request form.
  if (!token) return <Navigate to="/forgot-password" replace />

  if (tokenState === 'checking') {
    return <FullScreenSpinner label={auth.reset.checking} />
  }

  /*
   * FLOWS §5 sends the user back to S-04 WITH a banner, rather than leaving
   * them on a dead form. `replace` so Back does not return them to the broken
   * link.
   */
  if (tokenState !== 'valid') {
    return (
      <Navigate
        to={`/forgot-password?reason=${tokenState}`}
        replace
        state={{ banner: BANNER[tokenState] }}
      />
    )
  }

  const onSubmit = form.submit(async values => {
    try {
      await resetPassword(token, values.password)
      // No auto-login — FLOWS §5. Straight to the login screen with the
      // green confirmation banner.
      navigate('/login?reset=success', { replace: true })
    } catch (err) {
      if (!(err instanceof ApiError)) throw err

      if (err.code === NETWORK_ERROR_CODE) {
        form.setFormError(validation.networkFailure)
        return
      }
      if (err.code === ERROR_CODES.TOKEN_USED) {
        setTokenState('used')
        return
      }
      if (err.code === ERROR_CODES.TOKEN_EXPIRED) {
        setTokenState('expired')
        return
      }
      form.setFieldError('password', validation.passwordRules)
    }
  })

  return (
    <AuthLayout title={auth.reset.title}>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Input
            label={auth.reset.newPassword}
            revealable
            autoComplete="new-password"
            autoFocus
            data-testid="password"
            value={form.values.password}
            error={null}
            onChange={e => form.setValue('password', e.target.value)}
            onBlur={() => form.handleBlur('password')}
          />
          <PasswordStrength password={form.values.password} />
          {form.errors.password ? (
            <p data-field-error="" className="text-xs text-danger">
              {form.errors.password}
            </p>
          ) : null}
        </div>

        <Input
          label={auth.reset.confirmPassword}
          revealable
          autoComplete="new-password"
          data-testid="confirm"
          value={form.values.confirm}
          error={form.errors.confirm}
          onChange={e => form.setValue('confirm', e.target.value)}
          onBlur={() => form.handleBlur('confirm')}
        />

        {form.formError ? <FormError message={form.formError} /> : null}

        <Button type="submit" fullWidth loading={form.submitting} data-testid="submit">
          {auth.reset.submit}
        </Button>
      </form>
    </AuthLayout>
  )
}
