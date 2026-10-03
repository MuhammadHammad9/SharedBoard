// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { SessionExpiredBanner } from '../SessionExpiredBanner.js'
import { useAuthStore } from '../../../stores/authStore.js'
import { auth } from '../../../lib/strings.js'

describe('E-17 — session expired while the board is open', () => {
  afterEach(() => {
    cleanup()
    useAuthStore.setState({ sessionExpired: false })
  })

  it('renders nothing while the session is good', () => {
    render(<SessionExpiredBanner />)
    expect(screen.queryByTestId('session-expired-banner')).toBeNull()
  })

  it('shows a banner, not a redirect, and offers to log back in here', () => {
    window.history.replaceState(null, '', '/board/abc?debug=1')
    useAuthStore.getState().markSessionExpired()
    render(<SessionExpiredBanner />)

    expect(screen.getByRole('alert').textContent).toContain(auth.sessionExpired.message)
    // The board is still the page: the work on it is not thrown away.
    expect(window.location.pathname).toBe('/board/abc')
    expect(screen.getByTestId('session-expired-login').getAttribute('href')).toBe(
      `/login?next=${encodeURIComponent('/board/abc?debug=1')}`,
    )
  })
})
