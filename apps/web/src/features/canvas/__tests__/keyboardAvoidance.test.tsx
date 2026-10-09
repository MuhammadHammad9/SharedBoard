/**
 * @vitest-environment happy-dom
 *
 * FLOWS §14.5 — "Text editing scrolls the canvas so the edited object sits
 * above the keyboard."
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { STICKY_COLOURS, type BoardObject, type ObjectId } from '@coboard/shared'
import { boardStore } from '../../../stores/boardStore.js'
import { KEYBOARD_MARGIN_PX, keyboardPanDelta } from '../keyboardAvoidance.js'
import { TextOverlay } from '../TextOverlay.js'

describe('keyboardPanDelta', () => {
  it('is zero when the object already sits in the visible band', () => {
    expect(keyboardPanDelta(100, 300, 0, 500)).toBe(0)
  })

  it('pans up just enough to clear the keyboard, with a margin', () => {
    // Visible band ends at 400 (keyboard below); object bottom at 600.
    expect(keyboardPanDelta(450, 600, 0, 400)).toBe(400 - KEYBOARD_MARGIN_PX - 600)
  })

  it('aligns an object taller than the band by its top, where the caret is', () => {
    expect(keyboardPanDelta(300, 1000, 0, 400)).toBe(KEYBOARD_MARGIN_PX - 300)
  })

  it('pans down an object above the visible band', () => {
    expect(keyboardPanDelta(-50, 100, 0, 400)).toBe(KEYBOARD_MARGIN_PX + 50)
  })
})

describe('TextOverlay keeps the edited note above the keyboard', () => {
  const vv = Object.assign(new EventTarget(), { height: 800, offsetTop: 0 })

  beforeEach(() => {
    vi.stubGlobal('visualViewport', vv)
    vv.height = 800
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
    boardStore.getState().resetBoard()
    const note = {
      id: '00000001-0000-4000-8000-000000000000' as ObjectId,
      type: 'sticky',
      x: 0,
      y: 500,
      width: 200,
      height: 200,
      rotation: 0,
      zIndex: 'a0',
      opacity: 1,
      createdBy: 'test',
      createdAt: 0,
      updatedAt: 0,
      text: '',
      color: STICKY_COLOURS.yellow,
      fontSize: 'auto',
      textAlign: 'center',
    } as BoardObject
    boardStore.getState().loadObjects([note])
    boardStore.getState().beginTextEdit(note.id, true)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('pans the canvas (never the object) when the keyboard opens', () => {
    const { getByTestId } = render(<TextOverlay container={null} />)
    const input = getByTestId('text-overlay-input')
    // happy-dom does no layout: report the note's screen rect from its style.
    input.getBoundingClientRect = () => {
      const top = Number.parseFloat(input.style.top)
      return { top, bottom: top + 200 } as DOMRect
    }
    expect(boardStore.getState().viewport.y).toBe(0)

    act(() => {
      vv.height = 450 // keyboard up: 350 px gone
      vv.dispatchEvent(new Event('resize'))
    })

    const { viewport, objects } = boardStore.getState()
    expect(viewport.y).toBe(450 - KEYBOARD_MARGIN_PX - 700)
    // The stored coordinate is untouched — R-COORD-002.
    expect(objects.get('00000001-0000-4000-8000-000000000000' as ObjectId)?.y).toBe(500)
  })

  it('does nothing without a keyboard (a desktop window)', () => {
    render(<TextOverlay container={null} />)
    act(() => {
      vv.dispatchEvent(new Event('resize'))
    })
    expect(boardStore.getState().viewport.y).toBe(0)
  })
})
