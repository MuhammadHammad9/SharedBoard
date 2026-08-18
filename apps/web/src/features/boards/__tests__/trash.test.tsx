/**
 * @vitest-environment happy-dom
 *
 * Trash, and the Modal contract underneath it — FR-BOARD-006, FLOWS §6,
 * `R-A11Y-004`.
 *
 * Permanent delete is the one irreversible action in the product. The
 * confirmation is not decoration: without an exact-name gate, a mis-click on a
 * row destroys a colleague's afternoon and there is no restore path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { ToastProvider } from '../../../components/ui/Toast.js'
import { authStore } from '../../../stores/authStore.js'
import Trash from '../../../routes/Trash.js'

const USER = {
  id: 'user-1',
  email: 'priya@example.com',
  displayName: 'Priya Raman',
  avatarUrl: null,
  hasPassword: true,
  createdAt: '2026-01-01T00:00:00.000Z',
}

const trashed = {
  id: 'board-1',
  name: 'Offsite agenda',
  ownerId: USER.id,
  ownerName: 'Priya Raman',
  myRole: 'OWNER',
  thumbnailUrl: null,
  objectCount: 2,
  createdAt: '2026-06-01T09:00:00.000Z',
  updatedAt: '2026-08-14T09:00:00.000Z',
  lastActivityAt: '2026-08-14T09:00:00.000Z',
  deletedAt: '2026-08-14T09:00:00.000Z',
  daysUntilPurge: 26,
}

let calls: Array<{ url: string; method: string; body: unknown }> = []

function stub(status = 200, body: unknown = { boards: [trashed] }) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }),
  )
}

function renderTrash() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/trash']}>
          <Trash />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  calls = []
  authStore.setState({ user: USER, status: 'authenticated' })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Trash — S-08', () => {
  it('lists trashed boards with days remaining', async () => {
    stub()
    renderTrash()

    await screen.findByTestId('trash-row')
    // The days figure is the reason the screen exists. Trash without it is a
    // second inbox.
    expect(screen.getByTestId('days-remaining').textContent).toContain('26 days left')
  })

  it('shows the empty state when there is nothing deleted', async () => {
    stub(200, { boards: [] })
    renderTrash()

    const empty = await screen.findByTestId('trash-empty')
    expect(empty.textContent).toContain('Trash is empty')
  })

  it('restores a board', async () => {
    const user = userEvent.setup()
    stub()
    renderTrash()

    await screen.findByTestId('trash-row')
    await user.click(screen.getByTestId('restore'))

    await waitFor(() =>
      expect(
        calls.some(c => c.method === 'POST' && c.url.includes('/restore')),
      ).toBe(true),
    )
  })
})

describe('permanent delete — FR-BOARD-006', () => {
  it('keeps the confirm button disabled until the name matches EXACTLY', async () => {
    const user = userEvent.setup()
    stub()
    renderTrash()

    await screen.findByTestId('trash-row')
    await user.click(screen.getByTestId('delete-forever'))

    const confirm = screen.getByTestId('confirm-delete') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)

    // Case matters. "offsite agenda" is not "Offsite agenda", and accepting it
    // would make the gate a formality.
    await user.type(screen.getByTestId('confirm-name'), 'offsite agenda')
    expect(confirm.disabled).toBe(true)

    await user.clear(screen.getByTestId('confirm-name'))
    await user.type(screen.getByTestId('confirm-name'), 'Offsite agenda')
    expect(confirm.disabled).toBe(false)

    await user.click(confirm)
    await waitFor(() =>
      expect(calls.some(c => c.url.includes('/permanent-delete'))).toBe(true),
    )
  })

  it('traps focus, and Escape closes and restores it — R-A11Y-004', async () => {
    const user = userEvent.setup()
    stub()
    renderTrash()

    await screen.findByTestId('trash-row')
    const trigger = screen.getByTestId('delete-forever')
    trigger.focus()
    await user.click(trigger)

    const dialog = await screen.findByTestId('permanent-delete-modal')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    // Focus moved IN. Without this a keyboard user is still behind the
    // backdrop, tabbing through a page they cannot see.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('permanent-delete-modal')).toBeNull())
    // And it came back, rather than falling to the top of the document.
    expect(document.activeElement).toBe(trigger)
  })
})
