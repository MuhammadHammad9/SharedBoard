/**
 * @vitest-environment happy-dom
 *
 * S-13 — board settings (owner only), D-24: rename, a door into Share, and
 * move-to-trash behind a confirmation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { actions, boardSettings, boards as boardStrings } from '../../../lib/strings.js'

const hooks = vi.hoisted(() => ({
  rename: vi.fn(),
  trash: vi.fn(),
}))
vi.mock('../useBoards.js', () => ({
  useRenameBoard: () => ({ mutate: hooks.rename, isPending: false }),
  useTrashBoard: () => ({ mutate: hooks.trash, isPending: false }),
}))

const { BoardSettingsModal } = await import('../BoardSettingsModal.js')

const BOARD = '11111111-1111-4111-8111-111111111111'

function renderModal(over: Partial<Parameters<typeof BoardSettingsModal>[0]> = {}) {
  const props = {
    open: true,
    onClose: vi.fn(),
    boardId: BOARD,
    boardName: 'Q3 Retro',
    onRenamed: vi.fn(),
    onOpenShare: vi.fn(),
    ...over,
  }
  render(
    <MemoryRouter initialEntries={[`/board/${BOARD}`]}>
      <Routes>
        <Route path="/board/:id" element={<BoardSettingsModal {...props} />} />
        <Route path="/dashboard" element={<p data-testid="dashboard" />} />
      </Routes>
    </MemoryRouter>,
  )
  return props
}

beforeEach(() => {
  hooks.rename.mockReset()
  hooks.trash.mockReset()
})
afterEach(cleanup)

describe('S-13 board settings', () => {
  it('renames the board, optimistically, through the rename mutation', () => {
    const props = renderModal()
    expect(screen.getByRole('dialog', { name: boardSettings.title })).toBeTruthy()
    const save = screen.getByTestId('board-settings-save') as HTMLButtonElement
    // Unchanged name: nothing to save.
    expect(save.disabled).toBe(true)

    fireEvent.change(screen.getByTestId('board-settings-name'), {
      target: { value: '  Q4 Planning  ' },
    })
    fireEvent.click(save)
    expect(props.onRenamed).toHaveBeenCalledWith('Q4 Planning')
    expect(hooks.rename).toHaveBeenCalledWith(
      { id: BOARD, name: 'Q4 Planning' },
      expect.any(Object),
    )
  })

  it('refuses an empty name', () => {
    renderModal()
    fireEvent.change(screen.getByTestId('board-settings-name'), {
      target: { value: '   ' },
    })
    expect(
      (screen.getByTestId('board-settings-save') as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('rolls the header name back when the rename fails', () => {
    hooks.rename.mockImplementation((_v, opts: { onError: () => void }) => opts.onError())
    const props = renderModal()
    fireEvent.change(screen.getByTestId('board-settings-name'), {
      target: { value: 'New name' },
    })
    fireEvent.click(screen.getByTestId('board-settings-save'))
    expect(props.onRenamed).toHaveBeenLastCalledWith('Q3 Retro')
  })

  it('Share closes settings and opens S-12', () => {
    const props = renderModal()
    fireEvent.click(screen.getByTestId('board-settings-share'))
    expect(props.onClose).toHaveBeenCalled()
    expect(props.onOpenShare).toHaveBeenCalled()
  })

  it('move to trash asks first, then trashes and goes to the dashboard', () => {
    hooks.trash.mockImplementation((_id, opts: { onSuccess: () => void }) =>
      opts.onSuccess(),
    )
    renderModal()
    fireEvent.click(screen.getByTestId('board-settings-trash'))
    // Nothing yet: a confirmation, with the board-card copy.
    expect(hooks.trash).not.toHaveBeenCalled()
    expect(screen.getByText(boardStrings.deleteConfirmBody)).toBeTruthy()

    fireEvent.click(screen.getByTestId('board-settings-trash-confirm'))
    expect(hooks.trash).toHaveBeenCalledWith(BOARD, expect.any(Object))
    expect(screen.getByTestId('dashboard')).toBeTruthy()
  })

  it('cancelling the confirmation trashes nothing', () => {
    renderModal()
    fireEvent.click(screen.getByTestId('board-settings-trash'))
    fireEvent.click(screen.getByRole('button', { name: actions.cancel }))
    expect(hooks.trash).not.toHaveBeenCalled()
    expect(screen.getByTestId('board-settings-name')).toBeTruthy()
  })
})
