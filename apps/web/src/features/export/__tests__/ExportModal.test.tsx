/**
 * @vitest-environment happy-dom
 *
 * S-14 — FLOWS §11, E-22.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '../../../components/ui/Toast.js'
import { boardStore } from '../../../stores/boardStore.js'
import { exportStrings } from '../../../lib/strings.js'
import { ExportModal } from '../ExportModal.js'
import { openExport, useExportStore } from '../exportStore.js'

const size = () => ({ width: 1200, height: 800 })

function show() {
  render(
    <ToastProvider>
      <ExportModal boardName="Q3 Retrospective" getSize={size} />
    </ToastProvider>,
  )
  act(() => openExport())
}

beforeEach(() => {
  boardStore.getState().loadObjects([])
  boardStore.getState().setSelection([])
})

afterEach(() => {
  cleanup()
  useExportStore.setState({ open: false })
})

describe('ExportModal', () => {
  it('E-22: an empty board is blocked with the toast, and no file is made', async () => {
    show()
    await userEvent.click(screen.getByTestId('export-confirm'))
    expect(await screen.findByText(exportStrings.nothingToExport)).toBeTruthy()
    // Still open: the user has not got what they asked for.
    expect(screen.getByTestId('export-modal')).toBeTruthy()
  })

  it('"Current selection" is disabled when nothing is selected', () => {
    show()
    const selection = screen.getByTestId('export-scope-selection') as HTMLInputElement
    expect(selection.disabled).toBe(true)
    expect((screen.getByTestId('export-scope-board') as HTMLInputElement).checked).toBe(
      true,
    )
  })

  it('offers PNG, and SVG only as a disabled [P2] option', () => {
    show()
    const radios = screen.getAllByRole('radio', { name: /PNG|SVG/ }) as HTMLInputElement[]
    expect(radios.map(r => r.disabled)).toEqual([false, true])
  })

  it('Escape closes it', async () => {
    show()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('export-modal')).toBeNull()
  })
})
