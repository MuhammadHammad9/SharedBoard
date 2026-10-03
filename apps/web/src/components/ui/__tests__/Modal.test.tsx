/**
 * @vitest-environment happy-dom
 *
 * Modal — FLOWS §13.2 conventions (defect P14-5).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Modal } from '../Modal.js'

afterEach(() => cleanup())

function Confirm(props: Partial<Parameters<typeof Modal>[0]>) {
  return (
    <Modal
      open
      onClose={props.onClose ?? (() => {})}
      title="Delete forever?"
      footer={
        <>
          <button type="button">Cancel</button>
          <button type="button" data-autofocus>
            Delete
          </button>
        </>
      }
      {...props}
    >
      <p>Gone for good.</p>
    </Modal>
  )
}

describe('Modal', () => {
  it('locks body scroll while open and restores it on close', () => {
    document.body.style.overflow = 'auto'
    const { unmount } = render(<Confirm />)
    expect(document.body.style.overflow).toBe('hidden')
    unmount()
    expect(document.body.style.overflow).toBe('auto')
  })

  it('a confirmation opens focused on its primary action', () => {
    render(<Confirm />)
    expect(document.activeElement?.textContent).toBe('Delete')
  })

  it('a destructive modal ignores the backdrop, but Escape still closes it', async () => {
    const onClose = vi.fn()
    render(<Confirm destructive onClose={onClose} />)
    const backdrop = document.querySelector('[data-modal-backdrop]')!
    fireEvent.pointerDown(backdrop)
    fireEvent.click(backdrop)
    expect(onClose).not.toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('while not dismissible (a delete in flight), neither Escape nor the backdrop closes it', async () => {
    const onClose = vi.fn()
    render(<Confirm dismissible={false} onClose={onClose} />)
    await userEvent.keyboard('{Escape}')
    const backdrop = document.querySelector('[data-modal-backdrop]')!
    fireEvent.pointerDown(backdrop)
    fireEvent.click(backdrop)
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})
