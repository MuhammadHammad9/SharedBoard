/**
 * @vitest-environment happy-dom
 *
 * PRD §8.2 "Board too large" at the §7.2 soft warning (10,000 objects).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { OBJECT_COUNT_SOFT_WARNING, type BoardObject } from '@coboard/shared'
import { boardStore } from '../../../stores/boardStore.js'
import { BoardSizeWarning, isBoardLarge } from '../BoardSizeWarning.js'
import { actions, errors } from '../../../lib/strings.js'

/** Only the size matters to the warning, so the entries can be placeholders. */
const withCount = (count: number) =>
  act(() => {
    boardStore.setState({
      objects: new Map(
        Array.from({ length: count }, (_, i) => [String(i), {} as BoardObject]),
      ) as never,
    })
  })

beforeEach(() => boardStore.getState().resetBoard())
afterEach(cleanup)

describe('board-too-large warning', () => {
  it('turns on AT the soft threshold, not before', () => {
    expect(OBJECT_COUNT_SOFT_WARNING).toBe(10_000)
    expect(isBoardLarge(OBJECT_COUNT_SOFT_WARNING - 1)).toBe(false)
    expect(isBoardLarge(OBJECT_COUNT_SOFT_WARNING)).toBe(true)
  })

  it('shows the PRD §8.2 copy with Dismiss once the board crosses the line', () => {
    render(<BoardSizeWarning boardId="board-a" readOnly={false} />)
    expect(screen.queryByTestId('board-size-warning')).toBeNull()

    withCount(OBJECT_COUNT_SOFT_WARNING)
    expect(screen.getByTestId('board-size-warning').textContent).toContain(
      errors.boardTooLarge,
    )
    expect(screen.getByRole('button', { name: actions.dismiss })).toBeTruthy()

    // And goes when the board shrinks back below it.
    withCount(OBJECT_COUNT_SOFT_WARNING - 1)
    expect(screen.queryByTestId('board-size-warning')).toBeNull()
  })

  it('Dismiss hides it for that board, across a remount', () => {
    withCount(OBJECT_COUNT_SOFT_WARNING)
    const first = render(<BoardSizeWarning boardId="board-b" readOnly={false} />)
    fireEvent.click(screen.getByTestId('board-size-dismiss'))
    expect(screen.queryByTestId('board-size-warning')).toBeNull()
    first.unmount()

    render(<BoardSizeWarning boardId="board-b" readOnly={false} />)
    expect(screen.queryByTestId('board-size-warning')).toBeNull()
  })

  it('a different board still warns', () => {
    withCount(OBJECT_COUNT_SOFT_WARNING)
    render(<BoardSizeWarning boardId="board-c" readOnly={false} />)
    expect(screen.getByTestId('board-size-warning')).toBeTruthy()
  })

  it('is not shown to a viewer, who cannot act on it', () => {
    withCount(OBJECT_COUNT_SOFT_WARNING)
    render(<BoardSizeWarning boardId="board-d" readOnly />)
    expect(screen.queryByTestId('board-size-warning')).toBeNull()
  })
})
