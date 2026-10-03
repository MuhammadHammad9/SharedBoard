/**
 * @vitest-environment happy-dom
 *
 * R-A11Y-009 / FLOWS §13.3 — every shortcut is suppressed while a text input
 * or a MODAL has focus (defect P14-1), except Escape (and Cmd/Ctrl+Enter).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, renderHook } from '@testing-library/react'
import { boardStore } from '../../../stores/boardStore.js'
import { useKeyboard } from '../interaction/useKeyboard.js'
import { Modal } from '../../../components/ui/Modal.js'
import { useShortcutsStore } from '../../../components/board/shortcutsStore.js'

const press = (key: string, target: EventTarget = window, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))

beforeEach(() => {
  boardStore.getState().setReadOnly(false)
  boardStore.getState().setActiveTool('select')
  useShortcutsStore.setState({ open: false })
  renderHook(() => useKeyboard({ getSize: () => ({ width: 800, height: 600 }) }))
})

afterEach(() => cleanup())

describe('shortcut suppression', () => {
  it('a tool shortcut works on the board', () => {
    press('r')
    expect(boardStore.getState().activeTool).toBe('rect')
  })

  it('is suppressed while focus is in a text input', () => {
    const input = document.createElement('input')
    document.body.append(input)
    press('r', input)
    expect(boardStore.getState().activeTool).toBe('select')
    input.remove()
  })

  it('is suppressed while ANY modal is open, even with focus on a button in it', () => {
    render(
      <Modal open onClose={() => {}} title="Share">
        <button type="button">Copy</button>
      </Modal>,
    )
    const button = document.querySelector('[role="dialog"] button')!
    press('r', button)
    press('Delete', button)
    expect(boardStore.getState().activeTool).toBe('select')
  })

  it('`?` opens the shortcuts reference (S-15)', () => {
    press('?', window, { shiftKey: true })
    expect(useShortcutsStore.getState().open).toBe(true)
  })
})
