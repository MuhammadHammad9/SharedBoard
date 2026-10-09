/**
 * @vitest-environment happy-dom
 *
 * FLOWS §8.1 — the board shell, and "Loading 4,312 objects…" after 2 s.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { BoardShell, LOADING_COPY_AFTER_MS } from '../BoardShell.js'
import { loading } from '../../../lib/strings.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('BoardShell — FLOWS §8.1', () => {
  it('formats the count exactly as FLOWS shows it', () => {
    expect(loading.objects(4312)).toBe('Loading 4,312 objects…')
  })

  it('is silent for the first 2 s, then names the object count', () => {
    render(<BoardShell objectCount={4312} />)
    expect(screen.getByTestId('board-shell').getAttribute('aria-busy')).toBe('true')
    expect(screen.queryByTestId('board-loading-copy')).toBeNull()

    act(() => vi.advanceTimersByTime(LOADING_COPY_AFTER_MS - 1))
    expect(screen.queryByTestId('board-loading-copy')).toBeNull()

    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByTestId('board-loading-copy').textContent).toBe(
      'Loading 4,312 objects…',
    )
  })

  it('without a count it still says something at 2 s', () => {
    render(<BoardShell />)
    act(() => vi.advanceTimersByTime(LOADING_COPY_AFTER_MS))
    expect(screen.getByTestId('board-loading-copy').textContent).toBe(loading.board)
  })

  it('renders given content (the inline retry) in place of the spinner', () => {
    render(
      <BoardShell>
        <p>retry</p>
      </BoardShell>,
    )
    act(() => vi.advanceTimersByTime(LOADING_COPY_AFTER_MS))
    expect(screen.getByText('retry')).toBeTruthy()
    expect(screen.queryByTestId('board-loading-copy')).toBeNull()
  })
})
