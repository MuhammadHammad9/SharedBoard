/**
 * @vitest-environment happy-dom
 *
 * The auth screens' response branches — FLOWS §3.1 (8b, 8d, step 9), §1.2,
 * §5. The form timing rules have their own suite (formTiming.test.tsx).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { ERROR_CODES } from '@coboard/shared'
import { ApiError } from '../../../lib/api.js'
import { auth, errors } from '../../../lib/strings.js'
import { ToastProvider } from '../../../components/ui/Toast.js'

const authApi = vi.hoisted(() => ({ register: vi.fn(), login: vi.fn() }))
vi.mock('../api.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  register: authApi.register,
  login: authApi.login,
}))

const { default: Signup } = await import('../../../routes/Signup.js')
const { default: Login } = await import('../../../routes/Login.js')
const { default: ForgotPassword } = await import('../../../routes/ForgotPassword.js')

function Where() {
  const location = useLocation()
  return <div data-testid="where">{`${location.pathname}${location.search}`}</div>
}

function app(initial: string) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/signup" element={<Signup />} />
          <Route path="/login" element={<Login />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  )
}

async function fillSignup(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByTestId('email'), 'priya@example.com')
  await user.type(screen.getByTestId('password'), 'correct-horse-1')
  await user.type(screen.getByTestId('displayName'), 'Priya Raman')
}

beforeEach(() => {
  authApi.register.mockReset()
  authApi.login.mockReset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('S-02 signup', () => {
  it('8b — 409 offers "Log in instead", carrying the typed email and the deep link', async () => {
    authApi.register.mockRejectedValue(
      new ApiError(ERROR_CODES.EMAIL_TAKEN, 'taken', 409),
    )
    const user = userEvent.setup()
    app('/signup?next=%2Fboard%2Fabc')
    await fillSignup(user)
    await user.click(screen.getByTestId('submit'))

    expect(await screen.findByText(errors.emailAlreadyRegistered)).toBeTruthy()
    const link = screen.getByTestId('log-in-instead')
    expect(link.textContent).toBe(auth.signup.logInInstead)
    const target = new URL(link.getAttribute('href')!, 'http://x')
    expect(target.pathname).toBe('/login')
    expect(target.searchParams.get('email')).toBe('priya@example.com')
    expect(target.searchParams.get('next')).toBe('/board/abc')

    // ...and S-03 arrives with the address filled in and the caret on the
    // password, the only thing left to type.
    await user.click(link)
    const email = (await screen.findByTestId('email')) as HTMLInputElement
    expect(email.value).toBe('priya@example.com')
    expect(document.activeElement).toBe(screen.getByTestId('password'))
  })

  it('8d — 429 shows a countdown and keeps Create account disabled until it ends', async () => {
    authApi.register.mockRejectedValue(
      new ApiError(ERROR_CODES.RATE_LIMITED, 'slow down', 429, undefined, 2),
    )
    const user = userEvent.setup()
    app('/signup')
    await fillSignup(user)
    await user.click(screen.getByTestId('submit'))

    expect(await screen.findByText(errors.rateLimitedLogin(1))).toBeTruthy()
    const submit = screen.getByTestId('submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    // Two seconds of retryAfter, ticked off one second at a time.
    await waitFor(
      () => expect(screen.queryByText(errors.rateLimitedLogin(1))).toBeNull(),
      { timeout: 4_000 },
    )
    expect(submit.disabled).toBe(false)
  })

  it('step 9 — a successful signup raises "Welcome to CoBoard" once', async () => {
    authApi.register.mockResolvedValue({})
    const user = userEvent.setup()
    app('/signup')
    await fillSignup(user)
    await user.click(screen.getByTestId('submit'))

    expect((await screen.findByTestId('where')).textContent).toBe('/dashboard')
    expect(screen.getAllByText(auth.signup.welcome)).toHaveLength(1)
  })
})

describe('S-03 login', () => {
  it('links to S-02 with the FLOWS §1.2 label "Create one"', () => {
    app('/login')
    const link = screen.getByText(auth.login.signUp)
    expect(auth.login.signUp).toBe('Create one')
    expect(link.getAttribute('href')).toBe('/signup')
  })

  it('starts in the email field when nothing was carried over', () => {
    app('/login')
    expect(document.activeElement).toBe(screen.getByTestId('email'))
  })
})

describe('S-04 forgot password — the S-05 reason banner (FLOWS §5)', () => {
  it.each([
    ['expired', auth.reset.expired],
    ['invalid', auth.reset.invalid],
    ['used', auth.reset.used],
  ])('?reason=%s shows "%s"', (reason, copy) => {
    app(`/forgot-password?reason=${reason}`)
    expect(screen.getByTestId('reset-reason').textContent).toContain(copy)
    // The banner is announced, but the caret stays where the user types next.
    expect(document.activeElement).toBe(screen.getByTestId('email'))
  })

  it('shows nothing for no reason, or for one it does not know', () => {
    app('/forgot-password?reason=%3Cscript%3E')
    expect(screen.queryByTestId('reset-reason')).toBeNull()
    cleanup()
    app('/forgot-password')
    expect(screen.queryByTestId('reset-reason')).toBeNull()
  })

  it('keeps the banner up while the address is retyped', () => {
    app('/forgot-password?reason=expired')
    fireEvent.change(screen.getByTestId('email'), { target: { value: 'x' } })
    expect(screen.getByTestId('reset-reason')).toBeTruthy()
  })
})
