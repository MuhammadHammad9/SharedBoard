import { useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { DISPLAY_NAME_MAX, ERROR_CODES } from '@coboard/shared'
import { PasswordStrength, checkPassword } from '../features/auth/PasswordStrength.js'
import { useForm } from '../features/auth/useForm.js'
import {
  AVATAR_TYPES,
  AvatarFileError,
  changePassword,
  deleteAccount,
  logout,
  updateProfile,
  uploadAvatar,
} from '../features/auth/api.js'
import { ApiError } from '../lib/api.js'
import { useAuthStore } from '../stores/authStore.js'
import { Button } from '../components/ui/Button.js'
import { FormError } from '../components/ui/FormError.js'
import { Input } from '../components/ui/Input.js'
import { auth, errors, validation } from '../lib/strings.js'

/**
 * S-16 Profile settings — FR-SET-001.
 *
 * Three independent forms rather than one big save. Changing a display name
 * and changing a password have different consequences — the second logs you
 * out everywhere — and a single Save button that silently does both is how a
 * user ends their session by fixing a typo in their name.
 */
export default function Settings() {
  const user = useAuthStore(s => s.user)
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  if (!user) return null

  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-2xl flex-col gap-6 px-4 py-12">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-primary">{auth.settings.title}</h1>
        <Button
          variant="secondary"
          onClick={() => {
            // PRD FR-AUTH-007: logout "clears in-memory board caches, and
            // returns to the landing page". The header's logout gets the first
            // half for free from a full page load; this one is a client-side
            // navigation, so the cached board lists must be dropped by hand —
            // or the next person to log in on this tab sees them.
            void logout().then(() => {
              queryClient.clear()
              navigate('/', { replace: true })
            })
          }}
          data-testid="logout"
        >
          {auth.settings.logOut}
        </Button>
      </header>

      <ProfileSection displayName={user.displayName} email={user.email} />
      <AvatarSection displayName={user.displayName} avatarUrl={user.avatarUrl} />
      <PasswordSection hasPassword={user.hasPassword} />
      <DangerSection displayName={user.displayName} />
    </main>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-app p-6">
      <h2 className="text-base font-medium text-primary">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  )
}

function ProfileSection({ displayName, email }: { displayName: string; email: string }) {
  const [saved, setSaved] = useState(false)

  const form = useForm({ displayName }, values => ({
    displayName:
      values.displayName.trim().length > 0 ? undefined : validation.displayNameRequired,
  }))

  const onSubmit = form.submit(async values => {
    setSaved(false)
    try {
      await updateProfile({ displayName: values.displayName.trim() })
      setSaved(true)
    } catch {
      form.setFormError(auth.signup.genericFailure)
    }
  })

  return (
    <Card title={auth.settings.profile}>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <Input
          label={auth.settings.displayName}
          maxLength={DISPLAY_NAME_MAX}
          data-testid="settings-display-name"
          value={form.values.displayName}
          error={form.errors.displayName}
          onChange={e => {
            form.setValue('displayName', e.target.value)
            setSaved(false)
          }}
          onBlur={() => form.handleBlur('displayName')}
        />

        <Input
          label={auth.settings.email}
          value={email}
          readOnly
          disabled
          hint={auth.settings.emailReadOnly}
        />

        {form.formError ? <FormError message={form.formError} /> : null}

        <div className="flex items-center gap-3">
          <Button type="submit" loading={form.submitting} data-testid="settings-save">
            {auth.settings.save}
          </Button>
          {saved ? (
            <span role="status" className="text-sm text-success">
              {auth.settings.saved}
            </span>
          ) : null}
        </div>
      </form>
    </Card>
  )
}

/**
 * FR-SET-001 "change … avatar" — D-36. Upload or remove; the preview is the
 * same circle the dashboard cards draw.
 */
function AvatarSection({
  displayName,
  avatarUrl,
}: {
  displayName: string
  avatarUrl: string | null
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      await work()
      setSaved(true)
    } catch (err) {
      setError(
        err instanceof AvatarFileError
          ? err.reason === 'too_large'
            ? errors.uploadTooLarge
            : auth.settings.avatarUnsupported
          : auth.settings.avatarFailed,
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title={auth.settings.avatar}>
      <div className="flex flex-wrap items-center gap-4">
        <span
          className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-subtle text-sm font-semibold text-primary"
          data-testid="settings-avatar"
        >
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={auth.settings.avatarAlt(displayName)}
              referrerPolicy="no-referrer"
              className="h-full w-full object-cover"
            />
          ) : (
            <span aria-hidden="true">{initials(displayName)}</span>
          )}
        </span>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              loading={busy}
              onClick={() => input.current?.click()}
              data-testid="avatar-upload"
            >
              {auth.settings.avatarChange}
            </Button>
            {avatarUrl ? (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void run(() => updateProfile({ avatarUrl: null }))}
                data-testid="avatar-remove"
              >
                {auth.settings.avatarRemove}
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted">{auth.settings.avatarHint}</p>
        </div>

        <input
          ref={input}
          type="file"
          accept={AVATAR_TYPES.join(',')}
          className="hidden"
          data-testid="avatar-file"
          onChange={event => {
            const file = event.target.files?.[0]
            // Cleared, so choosing the same file again still fires a change.
            event.target.value = ''
            if (file) void run(() => uploadAvatar(file))
          }}
        />
      </div>

      {error ? (
        <div className="mt-4">
          <FormError message={error} />
        </div>
      ) : null}
      {saved ? (
        <p role="status" className="mt-4 text-sm text-success">
          {auth.settings.avatarSaved}
        </p>
      ) : null}
    </Card>
  )
}

/** Two letters, as on the dashboard's avatar button. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  const first = parts[0]?.[0] ?? ''
  const second = parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : ''
  return (first + second).toUpperCase() || '?'
}

function PasswordSection({ hasPassword }: { hasPassword: boolean }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const form = useForm({ currentPassword: '', newPassword: '' }, values => ({
    // An OAuth-only account is SETTING a first password, so there is nothing
    // to verify against — the server agrees, and enforces the same rule.
    currentPassword:
      !hasPassword || values.currentPassword.length > 0
        ? undefined
        : validation.passwordRequired,
    newPassword: Object.values(checkPassword(values.newPassword)).every(Boolean)
      ? undefined
      : validation.passwordRules,
  }))

  const onSubmit = form.submit(async values => {
    try {
      await changePassword({
        ...(hasPassword ? { currentPassword: values.currentPassword } : {}),
        newPassword: values.newPassword,
      })
      // Every session was revoked, this one included, so there is nowhere to
      // stay — send them to log in with the new password. The session is
      // over, so its cached boards go with it (FR-AUTH-007).
      queryClient.clear()
      navigate('/login?reset=success', { replace: true })
    } catch (err) {
      if (err instanceof ApiError && err.code === ERROR_CODES.INVALID_CREDENTIALS) {
        form.setFieldError('currentPassword', auth.settings.wrongCurrentPassword)
        return
      }
      form.setFormError(auth.signup.genericFailure)
    }
  })

  return (
    <Card title={hasPassword ? auth.settings.password : auth.settings.setPassword}>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {!hasPassword ? (
          <p className="text-sm text-muted">{auth.settings.setPasswordHint}</p>
        ) : (
          <Input
            label={auth.settings.currentPassword}
            revealable
            autoComplete="current-password"
            data-testid="current-password"
            value={form.values.currentPassword}
            error={form.errors.currentPassword}
            onChange={e => form.setValue('currentPassword', e.target.value)}
            onBlur={() => form.handleBlur('currentPassword')}
          />
        )}

        <div className="flex flex-col gap-2">
          <Input
            label={auth.settings.newPassword}
            revealable
            autoComplete="new-password"
            data-testid="new-password"
            value={form.values.newPassword}
            error={null}
            onChange={e => form.setValue('newPassword', e.target.value)}
            onBlur={() => form.handleBlur('newPassword')}
          />
          <PasswordStrength password={form.values.newPassword} />
          {form.errors.newPassword ? (
            <p data-field-error="" className="text-xs text-danger">
              {form.errors.newPassword}
            </p>
          ) : null}
        </div>

        {form.formError ? <FormError message={form.formError} /> : null}

        <Button type="submit" loading={form.submitting} data-testid="change-password">
          {auth.settings.changePassword}
        </Button>
      </form>
    </Card>
  )
}

function DangerSection({ displayName }: { displayName: string }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const form = useForm({ confirm: '' }, values => ({
    // Typing the exact display name — FR-SET-001. Checked here for feedback
    // and again on the server, because a client-only confirmation is theatre.
    confirm:
      values.confirm.trim() === displayName ? undefined : auth.settings.deleteMismatch,
  }))

  const onSubmit = form.submit(async values => {
    try {
      await deleteAccount(values.confirm.trim())
      queryClient.clear()
      navigate('/', { replace: true })
    } catch {
      form.setFormError(auth.signup.genericFailure)
    }
  })

  return (
    <section className="rounded-lg border border-danger/30 bg-app p-6">
      <h2 className="text-base font-medium text-danger">{auth.settings.dangerZone}</h2>
      <p className="mt-1 text-sm text-primary">{auth.settings.dangerBody}</p>

      <form onSubmit={onSubmit} noValidate className="mt-4 flex flex-col gap-4">
        <Input
          label={auth.settings.deleteConfirmLabel(displayName)}
          data-testid="delete-confirm"
          value={form.values.confirm}
          error={form.errors.confirm}
          onChange={e => form.setValue('confirm', e.target.value)}
          onBlur={() => form.handleBlur('confirm')}
        />

        {form.formError ? <FormError message={form.formError} /> : null}

        <Button
          type="submit"
          variant="danger"
          loading={form.submitting}
          data-testid="delete-account"
        >
          {auth.settings.deleteSubmit}
        </Button>
      </form>
    </section>
  )
}
