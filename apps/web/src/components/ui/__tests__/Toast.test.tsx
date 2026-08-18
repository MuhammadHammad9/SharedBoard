/**
 * @vitest-environment happy-dom
 *
 * Toast — FLOWS §6.7.
 *
 * The 8-second Undo is the requirement with teeth: it is how long a user has
 * to notice they trashed the wrong card. Everything tested here follows from
 * that number being real rather than nominal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { ToastProvider, useToast, TOAST_UNDO_MS } from '../Toast.js'

function Harness({ onShow }: { onShow: (show: ReturnType<typeof useToast>) => void }) {
  const api = useToast()
  return (
    <button type="button" data-testid="raise" onClick={() => onShow(api)}>
      raise
    </button>
  )
}

function renderToast(onShow: (api: ReturnType<typeof useToast>) => void) {
  return render(
    <ToastProvider>
      <Harness onShow={onShow} />
    </ToastProvider>,
  )
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const raise = () => act(() => void screen.getByTestId('raise').click())

describe('Toast', () => {
  it('shows a message and dismisses itself after its duration', () => {
    renderToast(api => api.show({ message: 'Moved to trash', durationMs: 1_000 }))
    raise()

    expect(screen.getByTestId('toast').textContent).toContain('Moved to trash')

    act(() => void vi.advanceTimersByTime(1_200))
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  it('gives the trash toast the full eight seconds', () => {
    const onAction = vi.fn()
    renderToast(api =>
      api.show({
        message: 'Moved to trash',
        durationMs: TOAST_UNDO_MS,
        action: { label: 'Undo', onAction },
      }),
    )
    raise()

    // Still there at seven seconds. A five-second toast would already be gone,
    // and the user reaching for Undo would find nothing.
    act(() => void vi.advanceTimersByTime(7_000))
    expect(screen.getByTestId('toast')).toBeTruthy()

    act(() => void screen.getByTestId('toast-action').click())
    expect(onAction).toHaveBeenCalledOnce()
  })

  it('pauses the timer while the pointer is over it', () => {
    renderToast(api => api.show({ message: 'Moved to trash', durationMs: 1_000 }))
    raise()

    const toast = screen.getByTestId('toast')
    act(() => void toast.dispatchEvent(new Event('pointerenter')))
    act(() => void vi.advanceTimersByTime(3_000))

    // A toast that expires while the user is moving toward Undo has failed at
    // its one job.
    expect(screen.getByTestId('toast')).toBeTruthy()

    act(() => void toast.dispatchEvent(new Event('pointerleave')))
    act(() => void vi.advanceTimersByTime(1_200))
    expect(screen.queryByTestId('toast')).toBeNull()
  })

  it('dismissing is NOT undoing', () => {
    const onAction = vi.fn()
    renderToast(api =>
      api.show({
        message: 'Moved to trash',
        durationMs: 5_000,
        action: { label: 'Undo', onAction },
      }),
    )
    raise()

    act(() => void screen.getByTestId('toast-dismiss').click())
    act(() => void vi.advanceTimersByTime(300))

    expect(screen.queryByTestId('toast')).toBeNull()
    // Closing the notification leaves the action done. Only Undo reverses it.
    expect(onAction).not.toHaveBeenCalled()
  })

  it('announces politely rather than interrupting', () => {
    renderToast(api => api.show({ message: 'Restored to your boards' }))
    raise()

    const toast = screen.getByTestId('toast')
    // role="alert" would cut a screen reader off mid-sentence. A confirmation
    // is not an interruption.
    expect(toast.getAttribute('role')).toBe('status')
    expect(toast.getAttribute('aria-live')).toBe('polite')
  })
})
