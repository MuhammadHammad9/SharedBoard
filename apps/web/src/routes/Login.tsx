import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { ERROR_CODES } from '@coboard/shared'
import { AuthLayout, OrDivider } from '../features/auth/AuthLayout.js'
import { useForm } from '../features/auth/useForm.js'
import { login, startGoogleOAuth } from '../features/auth/api.js'
import { ApiError, NETWORK_ERROR_CODE } from '../lib/api.js'
import { Button } from '../components/ui/Button.js'
import { FormError } from '../components/ui/FormError.js'
import { Input } from '../components/ui/Input.js'
import { auth, errors as errorStrings, validation } from '../lib/strings.js'
import { safeNext } from './nextParam.js'

/**
 * S-03 Login — FR-AUTH-002, FLOWS §4.
 *
 * Two details from §4 that are easy to skip and very noticeable when missing:
 *
 *   Branch 3b: on a wrong password, CLEAR the password, KEEP the email, and
 *   return focus to the password field. Clearing both would punish a typo by
 *   making the user retype an address they got right; leaving focus where it
 *   was means their next keystroke goes nowhere useful.
 *
 *   Branch 3c: a 429 shows a LIVE countdown, ticking down, not a static
 *   sentence. "Try again in 12 minutes" that still says 12 minutes four
 *   minutes later is worse than no number.
 *
 * And the one the spec calls the most common regression in auth work:
 * `?next=` must survive the round trip (see nextParam.ts).
 */
export default function Login() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  const passwordRef = useRef<HTMLInputElement>(null)

  /** Seconds left on a 429. Null when not rate-limited. */
  const [lockedFor, setLockedFor] = useState<number | null>(null)
  /** True after a wrong password, so the banner yields focus to the field. */
  const [credentialFailure, setCredentialFailure] = useState(false)

  const form = useForm({ email: '', password: '' }, values => ({
    email: !values.email
      ? validation.emailRequired
      : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)
        ? undefined
        : validation.emailInvalid,
    password: values.password.length > 0 ? undefined : validation.passwordRequired,
  }))

  /*
   * OAuth failures come back as a query parameter, because the callback is a
   * full page navigation and cannot hand us state any other way — FLOWS §3.3.
   */
  const oauthError = params.get('error')
  const banner =
    oauthError === 'oauth_denied'
      ? auth.login.oauthCancelled
      : oauthError === 'oauth'
        ? auth.login.oauthFailed
        : params.get('reset') === 'success'
          ? auth.login.passwordUpdated
          : null

  // The countdown. Ticks once a second and clears itself at zero.
  useEffect(() => {
    if (lockedFor === null) return
    if (lockedFor <= 0) {
      setLockedFor(null)
      form.setFormError(null)
      return
    }
    const timer = setTimeout(() => setLockedFor(s => (s === null ? null : s - 1)), 1000)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockedFor])

  const onSubmit = form.submit(async values => {
    setCredentialFailure(false)
    try {
      await login(values)
      navigate(next, { replace: true })
    } catch (err) {
      if (!(err instanceof ApiError)) throw err

      if (err.code === NETWORK_ERROR_CODE) {
        form.setFormError(validation.networkFailure)
        return
      }

      if (err.code === ERROR_CODES.RATE_LIMITED) {
        setLockedFor(err.retryAfter ?? 900)
        return
      }

      if (err.code === ERROR_CODES.ACCOUNT_DISABLED) {
        form.setFormError(auth.login.accountDisabled)
        return
      }

      /*
       * Branch 3b: clear the password, KEEP the email, return focus to the
       * password field. `credentialFailure` tells the banner not to grab
       * focus — see the note in FormError and defect D-8.
       */
      setCredentialFailure(true)
      form.setFormError(errorStrings.wrongCredentials)
      form.setValue('password', '')
      passwordRef.current?.focus()
    }
  })

  const countdown =
    lockedFor !== null
      ? errorStrings.rateLimitedLogin(Math.max(1, Math.ceil(lockedFor / 60)))
      : null

  return (
    <AuthLayout
      title={auth.login.title}
      subtitle={auth.login.subtitle}
      footer={
        <>
          {auth.login.noAccount}{' '}
          <Link to="/signup" className="font-medium text-accent hover:underline">
            {auth.login.signUp}
          </Link>
        </>
      }
    >
      {banner ? (
        <div className="mb-4">
          {params.get('reset') === 'success' ? (
            <p
              role="status"
              data-testid="reset-success"
              className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success"
            >
              {banner}
            </p>
          ) : (
            <FormError message={banner} />
          )}
        </div>
      ) : null}

      <Button
        variant="secondary"
        fullWidth
        onClick={() => startGoogleOAuth(params.get('next'))}
        data-testid="google-login"
      >
        {auth.login.google}
      </Button>

      <OrDivider label={auth.signup.or} />

      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <Input
          label={auth.fields.email}
          type="email"
          autoComplete="email"
          autoFocus
          data-testid="email"
          value={form.values.email}
          error={form.errors.email}
          onChange={e => form.setValue('email', e.target.value)}
          onBlur={() => form.handleBlur('email')}
        />

        <Input
          ref={passwordRef}
          label={auth.fields.password}
          revealable
          autoComplete="current-password"
          data-testid="password"
          value={form.values.password}
          error={form.errors.password}
          onChange={e => form.setValue('password', e.target.value)}
          onBlur={() => form.handleBlur('password')}
        />

        <div className="-mt-1 text-right">
          <Link
            to="/forgot-password"
            className="text-xs font-medium text-accent hover:underline"
          >
            {auth.login.forgot}
          </Link>
        </div>

        {countdown ? (
          <FormError message={countdown} />
        ) : form.formError ? (
          <FormError message={form.formError} autoFocus={!credentialFailure} />
        ) : null}

        <Button
          type="submit"
          fullWidth
          loading={form.submitting}
          // Disabled ONLY while locked out, which is a server decision rather
          // than a validation one — FLOWS §3.2 permits exactly this.
          disabled={lockedFor !== null}
          data-testid="submit"
        >
          {auth.login.submit}
        </Button>
      </form>
    </AuthLayout>
  )
}
