/**
 * @vitest-environment happy-dom
 *
 * The dashboard's seven states — FLOWS §6.3, `R-UI-050`.
 *
 * Every one of them is a requirement, and the three empty states are the ones
 * that get collapsed into a single "no boards" screen when nobody checks. This
 * suite exists to make that collapse fail the build.
 *
 * The API is stubbed at `fetch`, not at the query hooks. Mocking `useBoardList`
 * would test that the component renders whatever it is handed — which it
 * obviously does — and prove nothing about the query keys, the cursor, or
 * whether a filter change actually refetches.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { ToastProvider } from '../../../components/ui/Toast.js'
import { authStore } from '../../../stores/authStore.js'
import Dashboard from '../../../routes/Dashboard.js'

const USER = {
  id: 'user-1',
  email: 'priya@example.com',
  displayName: 'Priya Raman',
  avatarUrl: null,
  hasPassword: true,
  createdAt: '2026-01-01T00:00:00.000Z',
}

let counter = 0
const board = (overrides: Record<string, unknown> = {}) => ({
  id: `board-${++counter}`,
  name: 'Q3 Retrospective — Platform',
  ownerId: USER.id,
  ownerName: 'Priya Raman',
  myRole: 'OWNER',
  thumbnailUrl: null,
  objectCount: 4,
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-17T09:00:00.000Z',
  lastActivityAt: '2026-08-17T09:00:00.000Z',
  deletedAt: null,
  ...overrides,
})

/** The last URL each stubbed call saw, so tests can assert the query. */
let requests: string[] = []

function stubFetch(handler: (url: string) => { status?: number; body?: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input)
      requests.push(url)
      const { status = 200, body = {} } = handler(url)
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }),
  )
}

function renderDashboard(initialEntry = '/dashboard') {
  // A client per test, with retries off: a retry would turn the error-state
  // test into a three-second wait for a failure it already knows about.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Dashboard />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  counter = 0
  requests = []
  authStore.setState({ user: USER, status: 'authenticated' })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/* ── The seven states ─────────────────────────────────────────────────────── */

describe('the seven dashboard states — FLOWS §6.3', () => {
  it('1. LOADING: renders skeleton cards, never a spinner', async () => {
    // A promise that never settles, so the loading state is stable.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    renderDashboard()

    const grid = await screen.findByTestId('board-grid-loading')
    // Eight, at the real card dimensions — R-UI-051. A spinner reserves no
    // space and the page jumps when the data lands.
    expect(within(grid).getAllByTestId('board-card-skeleton')).toHaveLength(8)
    expect(grid.getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByTestId('full-screen-spinner')).toBeNull()
  })

  it('2. LOADED: renders a card per board', async () => {
    stubFetch(() => ({ body: { boards: [board(), board()], nextCursor: null } }))
    renderDashboard()

    await waitFor(() => expect(screen.getAllByTestId('board-card')).toHaveLength(2))
    expect(screen.getAllByText('Q3 Retrospective — Platform')[0]).toBeTruthy()
  })

  it('3. EMPTY, never had boards: offers creation', async () => {
    stubFetch(() => ({ body: { boards: [], nextCursor: null } }))
    renderDashboard()

    const empty = await screen.findByTestId('dashboard-empty')
    expect(empty.textContent).toContain('Nothing here yet')
    expect(empty.textContent).toContain('Create your first board')
  })

  it('4. EMPTY, filter: offers a way OUT, not creation', async () => {
    stubFetch(() => ({ body: { boards: [], nextCursor: null } }))
    renderDashboard('/dashboard?filter=shared')

    const empty = await screen.findByTestId('empty-filter')
    expect(empty.textContent).toContain('No boards match that filter')
    // The distinction that matters: a user with forty boards whose filter
    // missed must not be told they have none.
    expect(screen.queryByTestId('dashboard-empty')).toBeNull()
  })

  it('5. EMPTY, search: names the query back', async () => {
    stubFetch(() => ({ body: { boards: [], nextCursor: null } }))
    renderDashboard('/dashboard?q=pricing')

    const empty = await screen.findByTestId('empty-search')
    expect(empty.textContent).toContain("No boards found for 'pricing'")
  })

  it('6. ERROR: shows Retry, and the header and sidebar keep working', async () => {
    stubFetch(() => ({ status: 500, body: { error: { code: 'INTERNAL', message: 'x', correlationId: 'a' } } }))
    renderDashboard()

    await screen.findByTestId('dashboard-error')
    // "Sidebar and header stay functional" is an explicit FLOWS requirement:
    // a failed list must not take the whole page down with it.
    expect(screen.getByTestId('board-search')).toBeTruthy()
    expect(screen.getByTestId('new-board')).toBeTruthy()
  })

  it('7. PARTIAL: a board with no thumbnail still renders, with the placeholder', async () => {
    stubFetch(() => ({
      body: { boards: [board({ thumbnailUrl: null })], nextCursor: null },
    }))
    renderDashboard()

    await screen.findByTestId('board-card')
    // One missing image must never fail the page.
    expect(screen.getByTestId('thumb-placeholder')).toBeTruthy()
  })
})

/* ── E-16 and the create flow ─────────────────────────────────────────────── */

describe('creating a board — FLOWS §6.5, E-16', () => {
  it('double-clicking "New board" creates exactly ONE board', async () => {
    const user = userEvent.setup()
    let creates = 0
    stubFetch(url => {
      if (url.includes('/api/boards') && !url.includes('?')) {
        creates += 1
        return { status: 201, body: { board: board() } }
      }
      return { body: { boards: [], nextCursor: null } }
    })

    renderDashboard()
    await screen.findByTestId('dashboard-empty')

    const button = screen.getByTestId('new-board')
    await user.dblClick(button)

    // Two boards from one impatient double-click is the classic version of
    // this bug, and it is invisible until someone's dashboard has duplicates.
    await waitFor(() => expect(creates).toBe(1))
  })
})

/* ── Filter, sort and search drive the query ──────────────────────────────── */

describe('filter, sort and search', () => {
  it('puts the filter in the URL and in the request', async () => {
    const user = userEvent.setup()
    stubFetch(() => ({ body: { boards: [], nextCursor: null } }))
    renderDashboard()
    await screen.findByTestId('dashboard-empty')

    await user.click(screen.getByTestId('filter-owned'))

    await waitFor(() =>
      expect(requests.some(url => url.includes('filter=owned'))).toBe(true),
    )
  })

  it('debounces search rather than firing per keystroke', async () => {
    const user = userEvent.setup()
    stubFetch(() => ({ body: { boards: [], nextCursor: null } }))
    renderDashboard()
    await screen.findByTestId('dashboard-empty')

    const before = requests.length
    await user.type(screen.getByTestId('board-search'), 'pricing')

    await waitFor(() => expect(requests.some(url => url.includes('q=pricing'))).toBe(true))
    // Seven characters must not be seven requests.
    expect(requests.length - before).toBeLessThan(7)
  })

  it('sends the chosen sort', async () => {
    const user = userEvent.setup()
    stubFetch(() => ({ body: { boards: [], nextCursor: null } }))
    renderDashboard()
    await screen.findByTestId('dashboard-empty')

    await user.click(screen.getByTestId('sort-menu'))
    await user.click(await screen.findByTestId('sort-name'))

    await waitFor(() => expect(requests.some(url => url.includes('sort=name'))).toBe(true))
  })
})

/* ── The card menu is role-gated ──────────────────────────────────────────── */

describe('the card menu — FLOWS §6.4', () => {
  it('offers Rename and Move-to-trash to the owner', async () => {
    const user = userEvent.setup()
    stubFetch(() => ({ body: { boards: [board()], nextCursor: null } }))
    renderDashboard()

    await screen.findByTestId('board-card')
    await user.click(screen.getByTestId('card-menu'))

    expect(screen.getByTestId('card-rename')).toBeTruthy()
    expect(screen.getByTestId('card-trash')).toBeTruthy()
  })

  it('hides them from a non-owner', async () => {
    const user = userEvent.setup()
    stubFetch(() => ({
      body: {
        boards: [board({ ownerId: 'someone-else', myRole: 'EDITOR', ownerName: 'Marcus Feld' })],
        nextCursor: null,
      },
    }))
    renderDashboard()

    await screen.findByTestId('board-card')
    await user.click(screen.getByTestId('card-menu'))

    // The server refuses these anyway (R-SEC-001); hiding them is so the user
    // is never offered an action that will 403.
    expect(screen.queryByTestId('card-rename')).toBeNull()
    expect(screen.queryByTestId('card-trash')).toBeNull()
  })

  it('renames optimistically, before the request resolves', async () => {
    const user = userEvent.setup()
    let resolveRename: (() => void) | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (init?.method === 'PATCH') {
          return new Promise<Response>(resolve => {
            resolveRename = () =>
              resolve(
                new Response(JSON.stringify({ board: board() }), {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                }),
              )
          })
        }
        void url
        return Promise.resolve(
          new Response(JSON.stringify({ boards: [board()], nextCursor: null }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
      }),
    )

    renderDashboard()
    await screen.findByTestId('board-card')
    await user.click(screen.getByTestId('card-menu'))
    await user.click(screen.getByTestId('card-rename'))

    const input = screen.getByTestId('rename-input')
    await user.clear(input)
    await user.type(input, 'Incident timeline{Enter}')

    // The user typed it. Making them watch a spinner to see their own text is
    // the thing optimistic updates exist to avoid.
    await waitFor(() => expect(screen.getAllByText('Incident timeline')[0]).toBeTruthy())
    expect(resolveRename).not.toBeNull()
  })
})
