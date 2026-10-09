import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { ERROR_CODES, DISPLAY_NAME_MAX } from '@coboard/shared'
import { AuthLayout, OrDivider } from '../features/auth/AuthLayout.js'
import { PasswordStrength, checkPassword } from '../features/auth/PasswordStrength.js'
import { useForm } from '../features/auth/useForm.js'
import { register, startGoogleOAuth } from '../features/auth/api.js'
import { ApiError, NETWORK_ERROR_CODE } from '../lib/api.js'
import { Button } from '../components/ui/Button.js'
import { FormError } from '../components/ui/FormError.js'
import { Input } from '../components/ui/Input.js'
import { actions, auth, errors, validation } from '../lib/strings.js'
import { isSafeNext, safeNext } from './nextParam.js'
import { useToast } from '../components/ui/Toast.js'
import {
  announceAccountCreated,
  markSignupFromGuest,
} from '../features/auth/guestIdentity.js'

/**
 * S-02 Signup — FR-AUTH-001, FLOWS §3.
 *
 * All five response branches from §3.1 are handled: 201, 409 with a "Log in
 * instead" link carrying the typed email, 422 mapped per field, 429 with a
 * countdown, and a network failure that PRESERVES what the user typed.
 *
 * That last one is the branch most often skipped, and it is the one that
 * matters most: losing a filled-in form to a dropped connection is the point
 * at which someone gives up on signing up at all.
 */
/** 8d with no `retryAfter` from the server: wait a minute rather than not at all. */
const DEFAULT_LOCKOUT_SECONDS = 60

export default function Signup() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  const emailRef = useRef<HTMLInputElement>(null)
  const toast = useToast()
  /** Seconds left on a 429 (FLOWS §3.1 8d). Null when not rate-limited. */
  const [lockedFor, setLockedFor] = useState<number | null>(null)

  const form = useForm(
    { email: params.get('email') ?? '', password: '', displayName: '' },
    values => ({
      email: !values.email
        ? validation.emailRequired
        : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)
          ? undefined
          : validation.emailInvalid,
      password: Object.values(checkPassword(values.password)).every(Boolean)
        ? undefined
        : validation.passwordRules,
      displayName:
        values.displayName.trim().length > 0 ? undefined : validation.displayNameRequired,
    }),
  )

  // FLOWS §3.1 step 3: focus starts in the email field.
  useEffect(() => {
    emailRef.current?.focus()
  }, [])

  // 8d — the countdown. Ticks once a second; at zero the banner goes and the
  // button comes back, exactly as on S-03 (FLOWS §4 3c).
  useEffect(() => {
    if (lockedFor === null) return
    if (lockedFor <= 0) {
      setLockedFor(null)
      return
    }
    const timer = setTimeout(() => setLockedFor(s => (s === null ? null : s - 1)), 1000)
    return () => clearTimeout(timer)
  }, [lockedFor])

  const onSubmit = form.submit(async values => {
    try {
      await register({
        email: values.email,
        password: values.password,
        displayName: values.displayName.trim(),
      })
      /*
       * Guest → account (FLOWS §7.4). This tab was opened from a board by its
       * guest bar; the board tab is still open with the person's work on it.
       * Tell it — same origin only — and let it upgrade in place, rather than
       * taking them somewhere else. The refresh cookie this signup just set is
       * shared, so that tab can pick up the session itself.
       */
      if (params.get('from') === 'guest') announceAccountCreated()
      // FLOWS §3.1 step 9: "A one-time success toast: Welcome to CoBoard".
      // Raised here, once, because only a successful signup ever reaches this
      // line; the toast stack sits above the router, so it survives the
      // navigation to wherever `next` points (D-39).
      toast.show({ message: auth.signup.welcome })
      navigate(next, { replace: true })
    } catch (err) {
      if (!(err instanceof ApiError)) throw err

      // 8e — network. The form keeps every typed value; only a banner appears.
      if (err.code === NETWORK_ERROR_CODE) {
        form.setFormError(validation.networkFailure)
        return
      }

      // 8b — the email is taken. Inline on the field, with a route to log in.
      if (err.code === ERROR_CODES.EMAIL_TAKEN) {
        form.setFieldError('email', auth.signup.emailTaken)
        return
      }

      // 8d — rate limited: a live countdown from the server's retryAfter, and
      // the button stays disabled until it runs out.
      if (err.code === ERROR_CODES.RATE_LIMITED) {
        form.setFormError(null)
        setLockedFor(err.retryAfter ?? DEFAULT_LOCKOUT_SECONDS)
        return
      }

      // 8c — field-level validation from the server, mapped onto its input.
      if (err.code === ERROR_CODES.VALIDATION_FAILED && err.details) {
        for (const field of Object.keys(err.details)) {
          if (field === 'email') form.setFieldError('email', validation.emailInvalid)
          if (field === 'password')
            form.setFieldError('password', validation.passwordRules)
          if (field === 'displayName') {
            form.setFieldError('displayName', validation.displayNameRequired)
          }
        }
        return
      }

      form.setFormError(auth.signup.genericFailure)
    }
  })

  const countdown =
    lockedFor !== null
      ? errors.rateLimitedLogin(Math.max(1, Math.ceil(lockedFor / 60)))
      : null

  // 8b — "a 'Log in instead' link that carries the typed email to S-03",
  // and the deep link with it, so the detour still ends where it was going.
  const emailTaken = form.errors.email === auth.signup.emailTaken
  const logInInstead = (() => {
    const search = new URLSearchParams({ email: form.values.email })
    const rawNext = params.get('next')
    if (isSafeNext(rawNext)) search.set('next', rawNext)
    return `/login?${search.toString()}`
  })()

  return (
    <AuthLayout
      title={auth.signup.title}
      subtitle={auth.signup.subtitle}
      footer={
        <>
          {auth.signup.haveAccount}{' '}
          <Link to="/login" className="font-medium text-accent hover:underline">
            {auth.signup.logIn}
          </Link>
        </>
      }
    >
      <Button
        variant="secondary"
        fullWidth
        onClick={() => {
          // The Google path comes back through /auth/callback, which
          // announces the new account if this tab came from the guest bar.
          if (params.get('from') === 'guest') markSignupFromGuest()
          startGoogleOAuth(params.get('next'))
        }}
        data-testid="google-signup"
      >
        {auth.signup.google}
      </Button>

      <OrDivider label={auth.signup.or} />

      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <Input
          ref={emailRef}
          label={auth.fields.email}
          type="email"
          autoComplete="email"
          data-testid="email"
          value={form.values.email}
          error={form.errors.email}
          onChange={e => form.setValue('email', e.target.value)}
          onBlur={() => form.handleBlur('email')}
        />
        {emailTaken ? (
          <Link
            to={logInInstead}
            className="-mt-2 self-start text-sm font-medium text-accent hover:underline"
            data-testid="log-in-instead"
          >
            {auth.signup.logInInstead}
          </Link>
        ) : null}

        <div className="flex flex-col gap-2">
          <Input
            label={auth.fields.password}
            revealable
            autoComplete="new-password"
            data-testid="password"
            value={form.values.password}
            // The checklist below IS the error message, so showing the same
            // sentence twice would just be noise.
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
          label={auth.fields.displayName}
          autoComplete="name"
          maxLength={DISPLAY_NAME_MAX}
          data-testid="displayName"
          value={form.values.displayName}
          error={form.errors.displayName}
          onChange={e => form.setValue('displayName', e.target.value)}
          // Trim on blur, per FLOWS §3.1 step 6, so what is validated is what
          // will be stored.
          onBlur={() => {
            form.setValue('displayName', form.values.displayName.trim())
            form.handleBlur('displayName')
          }}
        />

        {countdown ? (
          <FormError message={countdown} />
        ) : form.formError ? (
          <FormError
            message={form.formError}
            action={
              form.formError === validation.networkFailure ? (
                <button
                  type="submit"
                  className="cursor-pointer font-medium underline"
                  data-testid="retry"
                >
                  {actions.retry}
                </button>
              ) : null
            }
          />
        ) : null}

        {/*
         * Never disabled for validation — FLOWS §3.2. Disabled only while the
         * request is in flight, which `loading` handles.
         */}
        <Button
          type="submit"
          fullWidth
          loading={form.submitting}
          // A server decision, not a validation one — FLOWS §3.2 permits it.
          disabled={lockedFor !== null}
          data-testid="submit"
        >
          {auth.signup.submit}
        </Button>
      </form>
    </AuthLayout>
  )
}
