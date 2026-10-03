/**
 * @vitest-environment happy-dom
 *
 * PRD §8.3 — "Pick a tool and start drawing", gone for good after the first object.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { BoardObject } from '@coboard/shared'
import { boardStore } from '../../../stores/boardStore.js'
import { emptyStates } from '../../../lib/strings.js'
import { BoardEmptyHint } from '../BoardEmptyHint.js'

const sticky = {
  id: '00000000-0000-4000-8000-000000000001',
  type: 'sticky',
  x: 0,
  y: 0,
  width: 200,
  height: 200,
  rotation: 0,
  zIndex: 'a0',
  opacity: 1,
  createdBy: 't',
  createdAt: 0,
  updatedAt: 0,
  text: '',
  color: '#FEF08A',
  fontSize: 16,
  textAlign: 'left',
} as BoardObject

const hint = () => screen.getByTestId('board-empty-hint')

beforeEach(() => {
  boardStore.getState().loadObjects([])
  boardStore.getState().setReadOnly(false)
})
afterEach(() => cleanup())

describe('BoardEmptyHint', () => {
  it('shows the exact PRD copy on a board that has never been edited', () => {
    render(<BoardEmptyHint neverEdited />)
    expect(hint().textContent).toBe(emptyStates.boardNoObjects.hint)
    expect(hint().dataset.gone).toBe('false')
  })

  it('fades out at the first object and stays gone when the board empties again', () => {
    render(<BoardEmptyHint neverEdited />)
    act(() => boardStore.getState().loadObjects([sticky]))
    expect(hint().dataset.gone).toBe('true')
    act(() => boardStore.getState().loadObjects([]))
    expect(hint().dataset.gone).toBe('true')
  })

  it('never shows on a board that once had objects, nor for a viewer', () => {
    render(<BoardEmptyHint neverEdited={false} />)
    expect(hint().dataset.gone).toBe('true')
    cleanup()
    act(() => boardStore.getState().setReadOnly(true))
    render(<BoardEmptyHint neverEdited />)
    expect(screen.queryByTestId('board-empty-hint')).toBeNull()
  })
})
