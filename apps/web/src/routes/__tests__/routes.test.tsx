/**
 * @vitest-environment happy-dom
 *
 * The router's edges — FLOWS §1.2, §2.1, PRD §6:
 *
 *   S-20 on `*`, with "Take me home" → S-01 or S-07
 *   S-08 at `/dashboard/trash`, with `/trash` kept as a redirect (D-30)
 *   guests leave S-17 / S-18 / S-19 for S-01, not a dashboard (D-31)
 *   S-15 on `?` off the board route (D-33)
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { actions, states } from '../../lib/strings.js'
import { authStore } from '../../stores/authStore.js'
import { startSessionBootstrap } from '../guards.js'
import App from '../../App.js'
import NotFound from '../NotFound.js'
import { BackHome } from '../../components/ui/FullScreenState.js'
import { GlobalShortcuts, isBoardPath } from '../../components/GlobalShortcuts.js'
import {
  closeShortcuts,
  useShortcutsStore,
} from '../../components/board/shortcutsStore.js'

const USER = {
  id: 'user-1',
  email: 'priya@example.com',
  displayName: 'Priya Raman',
  avatarUrl: null,
  hasPassword: true,
  createdAt: '2026-01-01T00:00:00.000Z',
}

/** Every request fails as "not signed in": the silent refresh says anonymous. */
const stubAnonymous = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  )

beforeAll(async () => {
  // Run the page's one silent refresh to completion up front, so each test
  // can then choose the auth status without a bootstrap racing it.
  stubAnonymous()
  startSessionBootstrap()
  await waitFor(() => expect(authStore.getState().status).toBe('anonymous'))
})

beforeEach(() => {
  stubAnonymous()
  authStore.getState().clear()
  closeShortcuts()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

describe('S-20 — the generic 404 (FLOWS §1.1, route `*`)', () => {
  it('renders for an unknown path instead of bouncing to the login form', async () => {
    window.history.replaceState(null, '', '/no/such/page')
    render(<App />)
    const page = await screen.findByTestId('not-found')
    expect(page.textContent).toContain(states.notFound.headline)
    expect(window.location.pathname).toBe('/no/such/page')
  })

  it('"Take me home" → S-01 when logged out', () => {
    render(
      <MemoryRouter>
        <NotFound />
      </MemoryRouter>,
    )
    const home = screen.getByTestId('take-me-home')
    expect(home.getAttribute('href')).toBe('/')
    expect(home.textContent).toBe(actions.takeMeHome)
  })

  it('"Take me home" → S-07 when logged in', () => {
    authStore.getState().setSession(USER, 'token')
    render(
      <MemoryRouter>
        <NotFound />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('take-me-home').getAttribute('href')).toBe('/dashboard')
  })
})

describe('S-08 lives at /dashboard/trash — PRD §6, FLOWS §2.1, D-30', () => {
  it('guards /dashboard/trash with ?next= back to it', async () => {
    window.history.replaceState(null, '', '/dashboard/trash')
    render(<App />)
    await waitFor(() => expect(window.location.pathname).toBe('/login'))
    expect(new URLSearchParams(window.location.search).get('next')).toBe(
      '/dashboard/trash',
    )
  })

  it('redirects the old /trash path there', async () => {
    window.history.replaceState(null, '', '/trash')
    render(<App />)
    await waitFor(() => expect(window.location.pathname).toBe('/login'))
    expect(new URLSearchParams(window.location.search).get('next')).toBe(
      '/dashboard/trash',
    )
  })
})

describe('the way out of a dead board — FLOWS §1.2, D-31', () => {
  const at = (path: string) =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <BackHome />
      </MemoryRouter>,
    )

  it('sends a guest (no session) to S-01 with "Back to home"', () => {
    at('/board/b')
    const link = screen.getByTestId('back-home')
    expect(link.getAttribute('href')).toBe('/')
    expect(link.textContent).toBe(actions.backToHome)
  })

  it('sends a signed-in user to S-07 with "Back to dashboard"', () => {
    authStore.getState().setSession(USER, 'token')
    at('/board/b')
    const link = screen.getByTestId('back-home')
    expect(link.getAttribute('href')).toBe('/dashboard')
    expect(link.textContent).toBe(actions.backToDashboard)
  })
})

describe('S-15 off the board — PRD §6 "any", Appendix A "Global", D-33', () => {
  const at = (path: string) =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <input data-testid="field" />
                <GlobalShortcuts />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    )

  it('opens the shortcuts modal on `?` from the dashboard', async () => {
    at('/dashboard')
    act(() => {
      fireEvent.keyDown(window, { key: '?' })
    })
    expect(useShortcutsStore.getState().open).toBe(true)
    expect(await screen.findByTestId('shortcuts-modal')).toBeTruthy()
  })

  it('never fires from a text field — R-A11Y-009', () => {
    at('/settings')
    fireEvent.keyDown(screen.getByTestId('field'), { key: '?' })
    expect(useShortcutsStore.getState().open).toBe(false)
  })

  it('leaves the board route to the board’s own keyboard layer', () => {
    at('/board/abc')
    act(() => {
      fireEvent.keyDown(window, { key: '?' })
    })
    expect(useShortcutsStore.getState().open).toBe(false)
    expect(isBoardPath('/demo')).toBe(true)
    expect(isBoardPath('/dashboard')).toBe(false)
  })
})
