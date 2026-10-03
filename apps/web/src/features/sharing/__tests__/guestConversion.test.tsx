/**
 * @vitest-environment happy-dom
 *
 * The guest bar and guest → account conversion — FLOWS §7.4.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const lib = vi.hoisted(() => ({
  attemptSilentRefresh: vi.fn(),
  get: vi.fn(),
  setGuestCredential: vi.fn(),
}))
vi.mock('../../../lib/api.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../lib/api.js')>()),
  attemptSilentRefresh: lib.attemptSilentRefresh,
  setGuestCredential: lib.setGuestCredential,
  api: { get: lib.get },
}))
const sharingApi = vi.hoisted(() => ({ claimGuestSeat: vi.fn() }))
vi.mock('../api.js', () => sharingApi)

const { GuestBar } = await import('../../../components/board/GuestBar.js')
const { useGuestConversion } = await import('../useGuestConversion.js')
const {
  ACCOUNT_CREATED_MESSAGE,
  announceAccountCreated,
  markSignupFromGuest,
  saveGuest,
  readGuest,
  clearGuest,
  takeSignupFromGuest,
} = await import('../../auth/guestIdentity.js')

/** An in-memory BroadcastChannel: every instance with a name hears the others. */
class FakeChannel {
  static open = new Set<FakeChannel>()
  onmessage: ((event: { data: unknown }) => void) | null = null
  constructor(readonly name: string) {
    FakeChannel.open.add(this)
  }
  postMessage(data: unknown) {
    for (const other of FakeChannel.open)
      if (other !== this && other.name === this.name) other.onmessage?.({ data })
  }
  close() {
    FakeChannel.open.delete(this)
  }
}

const BOARD = '00000000-0000-4000-8000-000000000001'

function storage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', storage())
  vi.stubGlobal('sessionStorage', storage())
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  clearGuest()
  for (const fn of [...Object.values(lib), ...Object.values(sharingApi)]) fn.mockReset()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the guest bar', () => {
  it('opens signup in a NEW tab that can post back, marked as from a guest', async () => {
    const open = vi.fn()
    vi.stubGlobal('open', open)
    render(<GuestBar boardId={BOARD} />)
    await userEvent.click(screen.getByTestId('guest-signup'))
    expect(open).toHaveBeenCalledWith(
      `/signup?from=guest&next=${encodeURIComponent(`/board/${BOARD}`)}`,
      '_blank',
    )
  })

  it('stays dismissed for this board for 7 days, and only this board', async () => {
    const { unmount } = render(<GuestBar boardId={BOARD} />)
    await userEvent.click(screen.getByTestId('guest-bar-dismiss'))
    expect(screen.queryByTestId('guest-bar')).toBeNull()
    unmount()

    render(<GuestBar boardId={BOARD} />)
    expect(screen.queryByTestId('guest-bar')).toBeNull()
    cleanup()
    render(<GuestBar boardId="another-board" />)
    expect(screen.getByTestId('guest-bar')).toBeTruthy()
  })
})

describe('useGuestConversion', () => {
  const post = (data: unknown, origin = window.location.origin) =>
    act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data, origin }))
      await new Promise(r => setTimeout(r, 0))
    })

  it('ignores messages from another origin, or of another kind', async () => {
    const guest = saveGuest('Marcus')
    const reconnect = vi.fn()
    const { result } = renderHook(() => useGuestConversion(BOARD, guest, reconnect))

    await post({ type: ACCOUNT_CREATED_MESSAGE }, 'https://evil.example')
    await post({ type: 'something-else' })
    expect(lib.attemptSilentRefresh).not.toHaveBeenCalled()
    expect(result.current).toEqual(guest)
  })

  it('upgrades in place: session, seat, identity cleared, socket reconnected', async () => {
    const guest = saveGuest('Marcus')
    lib.attemptSilentRefresh.mockResolvedValue(true)
    lib.get.mockResolvedValue({
      user: { id: 'u1', displayName: 'Marcus Lee', email: 'm@x.com' },
    })
    sharingApi.claimGuestSeat.mockResolvedValue({ role: 'EDITOR' })
    const reconnect = vi.fn()
    const { result } = renderHook(() => useGuestConversion(BOARD, guest, reconnect))

    await post({ type: ACCOUNT_CREATED_MESSAGE })

    expect(sharingApi.claimGuestSeat).toHaveBeenCalledWith(BOARD, guest.id)
    expect(lib.setGuestCredential).toHaveBeenCalledWith(null)
    expect(readGuest()).toBeNull()
    expect(reconnect).toHaveBeenCalledTimes(1)
    expect(result.current).toBeNull()
  })

  it('upgrades from a BroadcastChannel announcement — the Google path, with no opener', async () => {
    const guest = saveGuest('Marcus')
    lib.attemptSilentRefresh.mockResolvedValue(true)
    lib.get.mockResolvedValue({ user: { id: 'u1', displayName: 'M', email: 'm@x.com' } })
    sharingApi.claimGuestSeat.mockResolvedValue({ role: 'EDITOR' })
    const reconnect = vi.fn()
    const { result } = renderHook(() => useGuestConversion(BOARD, guest, reconnect))

    await act(async () => {
      announceAccountCreated()
      await new Promise(r => setTimeout(r, 0))
    })
    expect(sharingApi.claimGuestSeat).toHaveBeenCalledTimes(1)
    expect(result.current).toBeNull()
  })

  it('the from-guest mark survives the trip to Google once, and only once', () => {
    expect(takeSignupFromGuest()).toBe(false)
    markSignupFromGuest()
    expect(takeSignupFromGuest()).toBe(true)
    expect(takeSignupFromGuest()).toBe(false)
  })

  it('stays a guest, losing nothing, if the seat cannot be claimed', async () => {
    const guest = saveGuest('Marcus')
    lib.attemptSilentRefresh.mockResolvedValue(true)
    lib.get.mockResolvedValue({ user: { id: 'u1', displayName: 'M', email: 'm@x.com' } })
    sharingApi.claimGuestSeat.mockRejectedValue(new Error('gone'))
    const reconnect = vi.fn()
    const { result } = renderHook(() => useGuestConversion(BOARD, guest, reconnect))

    await post({ type: ACCOUNT_CREATED_MESSAGE })
    expect(result.current).toEqual(guest)
    expect(readGuest()).toEqual(guest)
    expect(reconnect).not.toHaveBeenCalled()
  })
})
