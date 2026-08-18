/**
 * @vitest-environment happy-dom
 *
 * Form validation TIMING — FLOWS §3.2, R-UI-058, R-UI-059.
 *
 * These three rules are the difference between a form that helps and one that
 * nags, and all three are invisible to a test that only checks whether an
 * error eventually appears. What matters is exactly WHEN.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import Signup from '../../../routes/Signup.js'
import { validation } from '../../../lib/strings.js'

afterEach(cleanup)

const renderSignup = () =>
  render(
    <MemoryRouter>
      <Signup />
    </MemoryRouter>,
  )

const emailField = () => screen.getByTestId('email')
const submitButton = () => screen.getByTestId('submit')

describe('rule 1 — never validate before the field has been left', () => {
  it('shows NO error while the user is still typing an email for the first time', async () => {
    const user = userEvent.setup()
    renderSignup()

    await user.type(emailField(), 'p')
    // "Validating on the first keystroke is hostile" — the user has typed one
    // character of an address they have not finished.
    expect(screen.queryByText(validation.emailInvalid)).toBeNull()

    await user.type(emailField(), 'riya@')
    expect(screen.queryByText(validation.emailInvalid)).toBeNull()
  })

  it('shows the error once the field is blurred', async () => {
    const user = userEvent.setup()
    renderSignup()

    await user.type(emailField(), 'not-an-email')
    await user.tab()

    expect(screen.getByText(validation.emailInvalid)).toBeTruthy()
  })
})

describe('rule 2 — once shown, re-validate on every keystroke', () => {
  it('clears the error the moment the value becomes valid, without another blur', async () => {
    const user = userEvent.setup()
    renderSignup()

    await user.type(emailField(), 'not-an-email')
    await user.tab()
    expect(screen.getByText(validation.emailInvalid)).toBeTruthy()

    // Back into the field and fix it. Making the user blur AGAIN to learn
    // they succeeded is the same hostility in reverse.
    await user.click(emailField())
    await user.type(emailField(), '@example.com')

    expect(screen.queryByText(validation.emailInvalid)).toBeNull()
  })

  it('re-shows the error live if the value goes back to being invalid', async () => {
    const user = userEvent.setup()
    renderSignup()

    await user.type(emailField(), 'priya@example.com')
    await user.tab()
    expect(screen.queryByText(validation.emailInvalid)).toBeNull()

    await user.click(emailField())
    await user.clear(emailField())
    await user.type(emailField(), 'broken')

    expect(screen.getByText(validation.emailInvalid)).toBeTruthy()
  })
})

describe('rule 3 — submit is never disabled for validation reasons', () => {
  it('stays enabled with an entirely empty form', () => {
    renderSignup()
    // "Let the user click and show them what is wrong." A disabled button
    // with no explanation is a dead end, and screen readers skip it.
    expect((submitButton() as HTMLButtonElement).disabled).toBe(false)
  })

  it('stays enabled with invalid input', async () => {
    const user = userEvent.setup()
    renderSignup()

    await user.type(emailField(), 'nope')
    await user.tab()

    expect((submitButton() as HTMLButtonElement).disabled).toBe(false)
  })

  it('surfaces every error at once when an empty form is submitted', async () => {
    const user = userEvent.setup()
    renderSignup()

    await user.click(submitButton())

    // Submitting touches every field, so one that was tabbed straight past
    // still explains itself rather than failing silently.
    expect(screen.getByText(validation.emailRequired)).toBeTruthy()
    expect(screen.getByText(validation.passwordRules)).toBeTruthy()
    expect(screen.getByText(validation.displayNameRequired)).toBeTruthy()
  })
})

describe('the password checklist — FLOWS §3.1 step 5', () => {
  it('tracks each rule live, from the first keystroke', async () => {
    const user = userEvent.setup()
    renderSignup()

    const password = screen.getByTestId('password')

    await user.type(password, 'abc')
    expect(screen.getByTestId('rule-letter').dataset.met).toBe('true')
    expect(screen.getByTestId('rule-number').dataset.met).toBe('false')
    expect(screen.getByTestId('rule-length').dataset.met).toBe('false')

    await user.type(password, 'defgh1')
    expect(screen.getByTestId('rule-length').dataset.met).toBe('true')
    expect(screen.getByTestId('rule-number').dataset.met).toBe('true')
  })

  it('is live even before blur, unlike the other fields', async () => {
    const user = userEvent.setup()
    renderSignup()

    // The checklist is not an error message — it is guidance, and guidance
    // that arrives after the fact is useless. Rule 1 does not apply to it.
    await user.type(screen.getByTestId('password'), 'a')
    expect(screen.getByTestId('password-strength')).toBeTruthy()
  })
})

describe('the reveal toggle — FLOWS §3.1 step 5', () => {
  it('switches the password field between hidden and visible', async () => {
    const user = userEvent.setup()
    renderSignup()

    const password = screen.getByTestId('password') as HTMLInputElement
    expect(password.type).toBe('password')

    await user.click(screen.getAllByTestId('reveal-password')[0]!)
    expect(password.type).toBe('text')
  })
})
