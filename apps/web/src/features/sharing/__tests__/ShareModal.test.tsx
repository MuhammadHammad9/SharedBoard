/**
 * @vitest-environment happy-dom
 *
 * S-12 — the share modal. FLOWS §10.2, FR-SHARE-002/003/004.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { actions, sharing } from '../../../lib/strings.js'
import { ToastProvider } from '../../../components/ui/Toast.js'

const api = vi.hoisted(() => ({
  listMembers: vi.fn(),
  getShareLink: vi.fn(),
  inviteMembers: vi.fn(),
  setMemberRole: vi.fn(),
  removeMember: vi.fn(),
  setShareLink: vi.fn(),
  disableShareLink: vi.fn(),
  resetShareLink: vi.fn(),
}))
vi.mock('../api.js', () => api)

const { ShareModal } = await import('../ShareModal.js')

const BOARD = '00000000-0000-4000-8000-000000000001'
const MEMBERS = [
  {
    id: 'm0',
    kind: 'user',
    name: 'Priya Raman',
    email: 'priya@x.com',
    role: 'OWNER',
    isOwner: true,
  },
  {
    id: 'm1',
    kind: 'user',
    name: 'Marcus Lee',
    email: 'marcus@x.com',
    role: 'EDITOR',
    isOwner: false,
  },
  { id: 'm2', kind: 'guest', name: 'Dana', email: null, role: 'VIEWER', isOwner: false },
]
const LINK = { token: 'T'.repeat(43), role: 'EDITOR', url: `/join/${'T'.repeat(43)}` }

function open() {
  return render(
    <ToastProvider>
      <ShareModal open onClose={() => {}} boardId={BOARD} boardName="Q3 Retrospective" />
    </ToastProvider>,
  )
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  api.listMembers.mockResolvedValue({ members: MEMBERS, invites: [] })
  api.getShareLink.mockResolvedValue({ link: null })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the share modal', () => {
  it('is titled with the board, lists people, and marks the owner and the guest', async () => {
    open()
    expect(screen.getByText(sharing.title('Q3 Retrospective'))).toBeTruthy()
    const rows = await screen.findAllByTestId('member-row')
    expect(rows).toHaveLength(3)
    expect(within(rows[0]!).getByText(sharing.owner)).toBeTruthy()
    expect(within(rows[0]!).queryByTestId('member-role')).toBeNull()
    expect(rows[2]!.textContent).toContain(`Dana ${sharing.guestSuffix}`)
  })

  it('blocks Send while any chip is not an email address', async () => {
    open()
    const input = await screen.findByTestId('invite-input')
    await userEvent.type(input, 'marcus@x.com,not-an-email,')
    const chips = screen.getAllByTestId('invite-chip')
    expect(chips.map(c => c.dataset.invalid)).toEqual(['false', 'true'])
    expect((screen.getByTestId('invite-send') as HTMLButtonElement).disabled).toBe(true)
  })

  it('sends invites, toasts the count, and clears the chips', async () => {
    api.inviteMembers.mockResolvedValue({ added: ['a@x.com'], invited: ['b@x.com'] })
    open()
    await userEvent.type(await screen.findByTestId('invite-input'), 'a@x.com, b@x.com')
    await userEvent.selectOptions(screen.getByTestId('invite-role'), 'VIEWER')
    await userEvent.click(screen.getByTestId('invite-send'))

    expect(api.inviteMembers).toHaveBeenCalledWith(
      BOARD,
      ['a@x.com', 'b@x.com'],
      'VIEWER',
    )
    expect(await screen.findByText(sharing.invitesSent(2))).toBeTruthy()
    expect(screen.queryAllByTestId('invite-chip')).toHaveLength(0)
  })

  it('changes a role at once, and puts it back with a toast if the server refuses', async () => {
    api.setMemberRole.mockRejectedValue(new Error('no'))
    open()
    const rows = await screen.findAllByTestId('member-row')
    const select = within(rows[1]!).getByTestId('member-role') as HTMLSelectElement
    await userEvent.selectOptions(select, 'VIEWER')

    expect(await screen.findByText(sharing.roleChangeFailed)).toBeTruthy()
    await waitFor(() => expect(select.value).toBe('EDITOR'))
  })

  it('asks before removing the last editor, and only then', async () => {
    api.removeMember.mockResolvedValue(undefined)
    open()
    const rows = await screen.findAllByTestId('member-row')
    await userEvent.click(within(rows[1]!).getByTestId('member-remove'))
    expect(api.removeMember).not.toHaveBeenCalled()
    expect(screen.getByText(sharing.removeLastEditor('Marcus Lee'))).toBeTruthy()

    await userEvent.click(within(rows[1]!).getByTestId('member-remove'))
    expect(api.removeMember).toHaveBeenCalledWith(BOARD, 'm1')
  })

  it('turns the link on, then copies it — "Copied!"', async () => {
    api.setShareLink.mockResolvedValue({ link: LINK })
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    open()

    await userEvent.selectOptions(await screen.findByTestId('link-access'), 'anyone')
    expect(api.setShareLink).toHaveBeenCalledWith(BOARD, 'EDITOR')
    const url = (await screen.findByTestId('link-url')) as HTMLInputElement
    expect(url.value).toBe(`${location.origin}${LINK.url}`)

    await userEvent.click(screen.getByTestId('link-copy'))
    expect(writeText).toHaveBeenCalledWith(url.value)
    expect(await screen.findByText(actions.copied)).toBeTruthy()
  })

  it('falls back to "Press Cmd/Ctrl+C to copy" when the Clipboard API fails', async () => {
    api.getShareLink.mockResolvedValue({ link: LINK })
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    open()
    await userEvent.click(await screen.findByTestId('link-copy'))
    expect((await screen.findByTestId('copy-fallback')).textContent).toMatch(
      /Press (Cmd|Ctrl)\+C to copy/,
    )
    expect(document.activeElement).toBe(screen.getByTestId('link-url'))
  })

  it('resets the link only after the confirmation', async () => {
    api.getShareLink.mockResolvedValue({ link: LINK })
    api.resetShareLink.mockResolvedValue({
      link: { ...LINK, token: 'N'.repeat(43), url: `/join/${'N'.repeat(43)}` },
    })
    open()
    await userEvent.click(await screen.findByTestId('link-reset'))
    expect(screen.getByText(sharing.resetConfirm)).toBeTruthy()
    expect(api.resetShareLink).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('reset-confirm-yes'))
    expect(api.resetShareLink).toHaveBeenCalledWith(BOARD)
    await waitFor(() =>
      expect((screen.getByTestId('link-url') as HTMLInputElement).value).toContain(
        'N'.repeat(43),
      ),
    )
  })

  it('the reset confirmation is a modal of its own: Escape closes it, not the share modal', async () => {
    api.getShareLink.mockResolvedValue({ link: LINK })
    open()
    await userEvent.click(await screen.findByTestId('link-reset'))
    expect(screen.getByTestId('reset-confirm').getAttribute('role')).toBe('dialog')

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('reset-confirm')).toBeNull()
    expect(screen.getByTestId('link-url')).toBeTruthy()
    expect(api.resetShareLink).not.toHaveBeenCalled()
  })

  it('switching to Restricted turns the link off', async () => {
    api.getShareLink.mockResolvedValue({ link: LINK })
    api.disableShareLink.mockResolvedValue({ link: null })
    open()
    await userEvent.selectOptions(await screen.findByTestId('link-access'), 'restricted')
    expect(api.disableShareLink).toHaveBeenCalledWith(BOARD)
    await waitFor(() => expect(screen.queryByTestId('link-url')).toBeNull())
  })
})
