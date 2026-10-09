/**
 * @vitest-environment happy-dom
 *
 * The board header's exits and intents — FLOWS §1.2 (back arrow: S-07 when
 * signed in, S-01 for a guest) and D-35 (`?export=1` from a dashboard card).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { actions } from '../../../lib/strings.js'
import { authStore } from '../../../stores/authStore.js'
import { closeExport, useExportStore } from '../../../features/export/exportStore.js'
import { BoardHeader } from '../BoardHeader.js'

const USER = {
  id: 'user-1',
  email: 'priya@example.com',
  displayName: 'Priya Raman',
  avatarUrl: null,
  hasPassword: true,
  createdAt: '2026-01-01T00:00:00.000Z',
}

function Search() {
  return <div data-testid="search">{useLocation().search}</div>
}

function renderHeader(path = '/board/b1', demo = false) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/board/:id"
            element={
              <>
                <BoardHeader
                  boardId="b1"
                  name="Q3 Retrospective"
                  role="EDITOR"
                  connection="connected"
                  demo={demo}
                />
                <Search />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  authStore.getState().clear()
  closeExport()
})

afterEach(cleanup)

describe('the back arrow — FLOWS §1.2', () => {
  it('goes to S-07 for a signed-in user', () => {
    authStore.getState().setSession(USER, 'token')
    renderHeader()
    const back = screen.getByTestId('board-back')
    expect(back.getAttribute('href')).toBe('/dashboard')
    expect(back.getAttribute('aria-label')).toBe(actions.backToDashboard)
  })

  it('goes to S-01 for a guest', () => {
    renderHeader()
    const back = screen.getByTestId('board-back')
    expect(back.getAttribute('href')).toBe('/')
    expect(back.getAttribute('aria-label')).toBe(actions.backToHome)
  })
})

describe('the export intent — D-35', () => {
  it('opens S-14 on ?export=1 and strips the flag', async () => {
    authStore.getState().setSession(USER, 'token')
    renderHeader('/board/b1?export=1')
    await waitFor(() => expect(useExportStore.getState().open).toBe(true))
    expect(screen.getByTestId('search').textContent).toBe('')
  })

  it('does nothing without it', () => {
    renderHeader()
    expect(useExportStore.getState().open).toBe(false)
  })
})
