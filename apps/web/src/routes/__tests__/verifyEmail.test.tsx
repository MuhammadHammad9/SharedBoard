/**
 * @vitest-environment happy-dom
 *
 * `/verify-email?token=` — D-22. The emailed link proves the address; the
 * server then claims the invites waiting for it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { ERROR_CODES } from '@coboard/shared'
import { verifyEmail as copy } from '../../lib/strings.js'

/*
 * A plain function wraps the spy rather than exporting a bare `vi.fn`: a
 * rejection returned straight from the spy was reported as a test failure
 * here even though the route handles it.
 */
const post = vi.hoisted(() => vi.fn())
vi.mock('../../lib/api.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../lib/api.js')>()),
  api: {
    post: (...args: unknown[]) => {
      post(...args)
      return reply()
    },
  },
}))
let reply: () => Promise<unknown> = async () => ({ ok: true, claimed: 0 })

const { default: VerifyEmail } = await import('../VerifyEmail.js')
const { ToastProvider } = await import('../../components/ui/Toast.js')
const { ApiError } = await import('../../lib/api.js')

function app(initial: string) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/verify-email" element={<VerifyEmail />} />
          <Route path="/dashboard" element={<p>dashboard</p>} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  )
}

beforeEach(() => post.mockReset())
afterEach(cleanup)

describe('S-verify-email', () => {
  it('posts the token once, then lands on the dashboard with a success toast', async () => {
    reply = async () => ({ ok: true, claimed: 1 })
    app('/verify-email?token=abc')
    await screen.findByText('dashboard')
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('/auth/verify-email', { token: 'abc' })
    expect(await screen.findByText(copy.verified)).toBeTruthy()
  })

  it('explains an expired or used link, and still lands on the dashboard', async () => {
    reply = () => Promise.reject(new ApiError(ERROR_CODES.TOKEN_EXPIRED, 'expired', 400))
    app('/verify-email?token=old')
    await screen.findByText('dashboard')
    expect(await screen.findByText(copy.expired)).toBeTruthy()
  })

  it('does not call the server without a token', async () => {
    app('/verify-email')
    await screen.findByText('dashboard')
    await waitFor(() => expect(screen.getByText(copy.invalid)).toBeTruthy())
    expect(post).not.toHaveBeenCalled()
  })
})
