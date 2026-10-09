/**
 * @vitest-environment happy-dom
 *
 * S-11 and the board guard — FLOWS §2.3, §7.1–7.3, FR-AUTH-006.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { ApiError } from '../../lib/api.js'
import { actions, guest, states } from '../../lib/strings.js'

const sharing = vi.hoisted(() => ({
  getShareCard: vi.fn(),
  joinAsGuest: vi.fn(),
}))
vi.mock('../../features/sharing/api.js', () => sharing)

const boards = vi.hoisted(() => ({ getBoardAccess: vi.fn() }))
vi.mock('../../features/boards/api.js', () => boards)

// Treat the session bootstrap as done: these tests choose the auth status.
vi.mock('../guards.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../guards.js')>()),
  useSessionBootstrap: () => {},
}))

const { default: GuestEntry } = await import('../GuestEntry.js')
const { RequireBoardAccess } = await import('../RequireBoardAccess.js')
const { useAuthStore } = await import('../../stores/authStore.js')
const { readGuest, saveGuest, clearGuest, rememberShareToken } =
  await import('../../features/auth/guestIdentity.js')

const BOARD = '00000000-0000-4000-8000-000000000001'
const TOKEN = 'A'.repeat(43)
const CARD = {
  boardId: BOARD,
  boardName: 'Q3 Retrospective',
  ownerName: 'Priya Raman',
  role: 'EDITOR',
  activeCount: 3,
  present: [
    { name: 'Priya', colour: '#EF4444' },
    { name: 'Dana', colour: '#22C55E' },
  ],
}

function storage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }
}

function app(initial: string) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/join/:token" element={<GuestEntry />} />
        <Route
          path="/board/:boardId"
          element={
            <RequireBoardAccess boardId={BOARD}>
              <div data-testid="the-board">board</div>
            </RequireBoardAccess>
          }
        />
        <Route path="/login" element={<div data-testid="login" />} />
      </Routes>
    </MemoryRouter>,
  )
}

const apiError = (status: number, reason?: string) =>
  new ApiError('X', 'x', status, reason ? { reason } : undefined)

beforeEach(() => {
  vi.stubGlobal('localStorage', storage())
  vi.stubGlobal('sessionStorage', storage())
  clearGuest()
  useAuthStore.setState({ status: 'anonymous' })
  sharing.getShareCard.mockReset()
  sharing.joinAsGuest.mockReset()
  boards.getBoardAccess.mockReset()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('S-11 — the join card', () => {
  it('shows the board, its owner, who is here, and focuses the name field', async () => {
    sharing.getShareCard.mockResolvedValue(CARD)
    app(`/join/${TOKEN}`)
    expect((await screen.findByTestId('join-board-name')).textContent).toBe(
      'Q3 Retrospective',
    )
    expect(screen.getByText(guest.sharedBy('Priya Raman'))).toBeTruthy()
    expect(screen.getByText(guest.hereNow(3))).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByTestId('join-name'))
  })

  it('refuses an empty name with the FLOWS copy, and sends nothing', async () => {
    sharing.getShareCard.mockResolvedValue(CARD)
    app(`/join/${TOKEN}`)
    await userEvent.click(await screen.findByTestId('join-submit'))
    expect(screen.getByText(guest.nameRequired)).toBeTruthy()
    expect(sharing.joinAsGuest).not.toHaveBeenCalled()
  })

  it('hard-stops at 40 characters and shows the counter from 30', async () => {
    sharing.getShareCard.mockResolvedValue(CARD)
    app(`/join/${TOKEN}`)
    const input = (await screen.findByTestId('join-name')) as HTMLInputElement
    await userEvent.type(input, 'x'.repeat(29))
    expect(screen.queryByTestId('join-counter')).toBeNull()
    await userEvent.type(input, 'x')
    expect(screen.getByTestId('join-counter').textContent).toBe('30/40')
    await userEvent.type(input, 'x'.repeat(20))
    expect(input.value).toHaveLength(40)
  })

  it('joins, saves the identity, and lands on the board', async () => {
    sharing.getShareCard.mockResolvedValue(CARD)
    sharing.joinAsGuest.mockResolvedValue({ boardId: BOARD, role: 'EDITOR' })
    boards.getBoardAccess.mockResolvedValue({ role: 'EDITOR' })
    app(`/join/${TOKEN}`)

    await userEvent.type(await screen.findByTestId('join-name'), 'Marcus{Enter}')
    expect(await screen.findByTestId('the-board')).toBeTruthy()

    const saved = readGuest()!
    expect(saved.name).toBe('Marcus')
    expect(sharing.joinAsGuest).toHaveBeenCalledWith(TOKEN, saved.id, 'Marcus')
  })

  it('shows the board-full state with Retry on a 403', async () => {
    sharing.getShareCard.mockResolvedValue(CARD)
    sharing.joinAsGuest.mockRejectedValue(apiError(403, 'board_full'))
    app(`/join/${TOKEN}`)
    await userEvent.type(await screen.findByTestId('join-name'), 'Marcus{Enter}')
    expect(await screen.findByText(guest.boardFull)).toBeTruthy()
  })

  it.each([
    [404, undefined, states.linkInvalid.headline],
    [410, 'revoked', states.linkTurnedOff.headline],
    [410, 'deleted', states.boardGone.headline],
  ])('a %i (%s) link shows "%s"', async (status, reason, headline) => {
    sharing.getShareCard.mockRejectedValue(apiError(status, reason))
    app(`/join/${TOKEN}`)
    expect(await screen.findByText(headline)).toBeTruthy()
  })

  it('offers "Log in instead" → S-03 with ?next= back through this link — FLOWS §1.2, D-37', async () => {
    sharing.getShareCard.mockResolvedValue(CARD)
    app(`/join/${TOKEN}`)
    const link = await screen.findByTestId('join-log-in')
    expect(link.textContent).toBe(actions.logInInstead)
    expect(link.getAttribute('href')).toBe(
      `/login?next=${encodeURIComponent(`/join/${TOKEN}`)}`,
    )
    await userEvent.click(link)
    expect(await screen.findByTestId('login')).toBeTruthy()
  })

  it('a dead link sends a guest home to S-01, not to a dashboard they cannot see', async () => {
    sharing.getShareCard.mockRejectedValue(apiError(404))
    app(`/join/${TOKEN}`)
    const back = await screen.findByTestId('back-home')
    expect(back.getAttribute('href')).toBe('/')
    expect(back.textContent).toBe(actions.backToHome)
  })

  it('a returning guest skips the card entirely — FLOWS §7.2', async () => {
    saveGuest('Marcus')
    sharing.getShareCard.mockResolvedValue(CARD)
    sharing.joinAsGuest.mockResolvedValue({ boardId: BOARD, role: 'EDITOR' })
    boards.getBoardAccess.mockResolvedValue({ role: 'EDITOR' })
    app(`/join/${TOKEN}`)
    expect(await screen.findByTestId('the-board')).toBeTruthy()
    expect(screen.queryByTestId('join-name')).toBeNull()
  })

  it('a signed-in visitor goes straight to the board, not through the guest join', async () => {
    useAuthStore.setState({ status: 'authenticated' })
    sharing.getShareCard.mockResolvedValue(CARD)
    boards.getBoardAccess.mockResolvedValue({ role: 'EDITOR' })
    app(`/join/${TOKEN}`)
    expect(await screen.findByTestId('the-board')).toBeTruthy()
    expect(sharing.joinAsGuest).not.toHaveBeenCalled()
    // ...and the guard presents the token so /access can make them a member.
    expect(boards.getBoardAccess).toHaveBeenCalledWith(BOARD, TOKEN)
  })
})

describe('requireBoardAccess — FLOWS §2.3 STEP 4', () => {
  it('renders the board for a member', async () => {
    useAuthStore.setState({ status: 'authenticated' })
    boards.getBoardAccess.mockResolvedValue({ role: 'OWNER' })
    app(`/board/${BOARD}`)
    expect(await screen.findByTestId('the-board')).toBeTruthy()
  })

  it('shows the board shell, never a blank page, while resolving', () => {
    useAuthStore.setState({ status: 'authenticated' })
    boards.getBoardAccess.mockReturnValue(new Promise(() => {}))
    app(`/board/${BOARD}`)
    expect(screen.getByTestId('board-shell')).toBeTruthy()
  })

  it('sends an anonymous visitor with a live link to S-11', async () => {
    rememberShareToken(BOARD, TOKEN)
    sharing.getShareCard.mockReturnValue(new Promise(() => {}))
    boards.getBoardAccess.mockResolvedValue({
      role: 'none',
      joinable: true,
      requiresName: true,
    })
    app(`/board/${BOARD}`)
    expect(await screen.findByTestId('join-card')).toBeTruthy()
  })

  it('shows a fully anonymous visitor with no link S-17, with a Log in that returns here', async () => {
    // FLOWS §2.4: not a member and no share token → S-17. It still asks the
    // server, so a missing or deleted board is S-18, not S-17.
    boards.getBoardAccess.mockRejectedValue(apiError(403, 'no_access'))
    app(`/board/${BOARD}`)
    expect(await screen.findByText(states.accessDenied.headline)).toBeTruthy()
    expect(boards.getBoardAccess).toHaveBeenCalled()
    const logIn = screen.getByTestId('forbidden-log-in')
    expect(logIn.getAttribute('href')).toBe(
      `/login?next=${encodeURIComponent(`/board/${BOARD}`)}`,
    )
    // FLOWS §1.2: S-17 "Back to home" → S-01 for someone with no account.
    expect(screen.getByTestId('back-home').getAttribute('href')).toBe('/')
  })

  it('S-18 sends a guest to S-01 and a member to S-07 — D-31', async () => {
    boards.getBoardAccess.mockRejectedValue(apiError(404))
    app(`/board/${BOARD}`)
    expect((await screen.findByTestId('back-home')).getAttribute('href')).toBe('/')
    cleanup()

    useAuthStore.setState({ status: 'authenticated' })
    app(`/board/${BOARD}`)
    expect((await screen.findByTestId('back-home')).getAttribute('href')).toBe(
      '/dashboard',
    )
  })

  it('S-17 for a signed-in user says who they are, with Switch account', async () => {
    useAuthStore.setState({
      status: 'authenticated',
      user: { id: 'u1', email: 'priya@x.com', displayName: 'Priya' } as never,
    })
    boards.getBoardAccess.mockRejectedValue(apiError(403, 'no_access'))
    app(`/board/${BOARD}`)
    expect((await screen.findByTestId('forbidden-account')).textContent).toContain(
      'Signed in as priya@x.com',
    )
  })

  it.each([
    [403, 'no_access', states.accessDenied.headline],
    [403, 'link_revoked', states.accessRemoved.headline],
    [404, undefined, states.boardNotFound.headline],
    [410, 'deleted', states.boardGone.headline],
  ])('%i %s → "%s"', async (status, reason, headline) => {
    useAuthStore.setState({ status: 'authenticated' })
    boards.getBoardAccess.mockRejectedValue(apiError(status, reason))
    app(`/board/${BOARD}`)
    expect(await screen.findByText(headline)).toBeTruthy()
  })

  it('offers an inline retry inside the canvas area on a network failure', async () => {
    useAuthStore.setState({ status: 'authenticated' })
    boards.getBoardAccess
      .mockRejectedValueOnce(new ApiError('NETWORK', 'x', 0))
      .mockResolvedValueOnce({ role: 'EDITOR' })
    app(`/board/${BOARD}`)
    expect(await screen.findByTestId('board-access-error')).toBeTruthy()
    await userEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByTestId('the-board')).toBeTruthy())
  })
})
