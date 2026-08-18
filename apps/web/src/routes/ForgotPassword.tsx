import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { AuthLayout } from '../features/auth/AuthLayout.js'
import { useForm } from '../features/auth/useForm.js'
import { forgotPassword } from '../features/auth/api.js'
import { ApiError, NETWORK_ERROR_CODE } from '../lib/api.js'
import { Button } from '../components/ui/Button.js'
import { FormError } from '../components/ui/FormError.js'
import { Input } from '../components/ui/Input.js'
import { auth, validation } from '../lib/strings.js'

/** FLOWS §5: the resend button is disabled for 60 s with a countdown. */
const RESEND_COOLDOWN_SECONDS = 60

/**
 * S-04 Forgot password — FR-AUTH-004, FLOWS §5.
 *
 * Two states in one screen: the form, then a confirmation.
 *
 * The confirmation is deliberately vague — "If an account exists for
 * priya@x.com…" — and that phrasing is not hedging. The server returns 200
 * whether or not the address is registered (R-SEC-008), so the copy has to
 * match: saying "We've sent you a link" would assert something the server
 * refuses to confirm, and saying "No such account" would be the enumeration
 * leak the 200 exists to prevent.
 */
export default function ForgotPassword() {
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [cooldown, setCooldown] = useState(0)

  const form = useForm({ email: '' }, values => ({
    email: !values.email
      ? validation.emailRequired
      : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)
        ? undefined
        : validation.emailInvalid,
  }))

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setTimeout(() => setCooldown(s => s - 1), 1000)
    return () => clearTimeout(timer)
  }, [cooldown])

  const send = async (email: string) => {
    try {
      await forgotPassword(email)
      setSentTo(email)
      setCooldown(RESEND_COOLDOWN_SECONDS)
    } catch (err) {
      if (err instanceof ApiError && err.code === NETWORK_ERROR_CODE) {
        form.setFormError(validation.networkFailure)
        return
      }
      // A 429 is the only other expected failure, and the generic message is
      // right for it: the user's action is the same either way — wait.
      form.setFormError(auth.signup.genericFailure)
    }
  }

  const onSubmit = form.submit(values => send(values.email))

  if (sentTo) {
    return (
      <AuthLayout
        title={auth.forgot.sentTitle}
        footer={
          <Link to="/login" className="font-medium text-accent hover:underline">
            {auth.forgot.backToLogin}
          </Link>
        }
      >
        <p className="text-sm text-primary" data-testid="reset-sent">
          {auth.forgot.sentBody(sentTo)}
        </p>

        <div className="mt-6">
          <Button
            variant="secondary"
            fullWidth
            disabled={cooldown > 0}
            onClick={() => void send(sentTo)}
            data-testid="resend"
          >
            {cooldown > 0 ? auth.forgot.resendIn(cooldown) : auth.forgot.resend}
          </Button>
        </div>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout
      title={auth.forgot.title}
      subtitle={auth.forgot.subtitle}
      footer={
        <Link to="/login" className="font-medium text-accent hover:underline">
          {auth.forgot.backToLogin}
        </Link>
      }
    >
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

        {form.formError ? <FormError message={form.formError} /> : null}

        <Button type="submit" fullWidth loading={form.submitting} data-testid="submit">
          {auth.forgot.submit}
        </Button>
      </form>
    </AuthLayout>
  )
}
