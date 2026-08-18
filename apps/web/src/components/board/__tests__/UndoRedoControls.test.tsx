/**
 * @vitest-environment happy-dom
 *
 * Undo / redo controls — FR-CANVAS-018, FLOWS §14.2.
 *
 * FLOWS specifies "disabled when the corresponding stack is empty", and that
 * enabled/disabled state is the whole of this component's behaviour. It is
 * worth a component test rather than only a unit one because the binding
 * between a plain-TypeScript stack and React is a `useSyncExternalStore`
 * subscription, and a subscription that never fires looks exactly like a
 * feature that does not work.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { strokeBounds, type BoardObject, type ObjectId } from '@coboard/shared'
import { boardStore } from '../../../stores/boardStore.js'
import { history } from '../../../features/canvas/history/history.js'
import { applyAndEmit, createOps } from '../../../features/canvas/history/apply.js'
import { LABELS } from '../../../features/canvas/history/grouping.js'
import { UndoRedoControls } from '../UndoRedoControls.js'

let seq = 0
function stroke(): BoardObject {
  seq++
  const points = [0, 0, 0.5, 20, 20, 0.5]
  return {
    id: (`${seq}`.padStart(8, '0') + '-0000-4000-8000-000000000000') as ObjectId,
    type: 'stroke',
    ...strokeBounds(points, 2),
    rotation: 0,
    zIndex: `a${`${seq}`.padStart(6, '0')}`,
    opacity: 1,
    createdBy: 'test',
    createdAt: 0,
    updatedAt: 0,
    points,
    color: '#18181B',
    strokeWidth: 2,
    simplified: true,
  } as BoardObject
}

beforeEach(() => {
  seq = 0
  history.clear()
  boardStore.setState({
    objects: new Map(),
    objectsVersion: 0,
    sortedIds: [],
    selection: [],
  })
})

afterEach(cleanup)

const undoButton = () => screen.getByTestId('undo-button')
const redoButton = () => screen.getByTestId('redo-button')

describe('UndoRedoControls', () => {
  it('starts with both controls unavailable', () => {
    render(<UndoRedoControls />)
    expect(undoButton().getAttribute('aria-disabled')).toBe('true')
    expect(redoButton().getAttribute('aria-disabled')).toBe('true')
  })

  it('R-A11Y-002: both controls have an accessible name and their shortcut', () => {
    render(<UndoRedoControls />)
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Redo' })).toBeTruthy()
    expect(undoButton().getAttribute('aria-keyshortcuts')).toContain('Z')
  })

  it('enables undo the moment an action is recorded', () => {
    render(<UndoRedoControls />)
    act(() => {
      applyAndEmit(createOps([stroke()]), LABELS.draw)
    })
    expect(undoButton().getAttribute('aria-disabled')).toBe('false')
    expect(redoButton().getAttribute('aria-disabled')).toBe('true')
  })

  it('clicking undo reverts the action and enables redo', async () => {
    const user = userEvent.setup()
    render(<UndoRedoControls />)

    const object = stroke()
    act(() => {
      applyAndEmit(createOps([object]), LABELS.draw)
    })
    expect(boardStore.getState().objects.size).toBe(1)

    await user.click(undoButton())

    expect(boardStore.getState().objects.size).toBe(0)
    expect(undoButton().getAttribute('aria-disabled')).toBe('true')
    expect(redoButton().getAttribute('aria-disabled')).toBe('false')

    await user.click(redoButton())
    expect(boardStore.getState().objects.has(object.id)).toBe(true)
  })

  it('stays focusable while unavailable — aria-disabled, not disabled', async () => {
    const user = userEvent.setup()
    render(<UndoRedoControls />)

    // A `disabled` button leaves the tab order, so a keyboard user sweeping
    // the bottom bar would never learn the control is there.
    await user.tab()
    expect(document.activeElement).toBe(undoButton())
  })

  it('clicking an unavailable control does nothing', async () => {
    const user = userEvent.setup()
    render(<UndoRedoControls />)
    await user.click(undoButton())
    expect(history.canUndo()).toBe(false)
    expect(history.canRedo()).toBe(false)
  })
})
