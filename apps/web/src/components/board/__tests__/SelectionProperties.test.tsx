/**
 * @vitest-environment happy-dom
 *
 * Properties panel for a selection — FLOWS §14.4.
 *
 * The three multi-selection rows of §14.4 are the point of this suite: same
 * type, mixed types, and differing values rendering as "Mixed".
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { strokeBounds, type BoardObject, type ObjectId } from '@coboard/shared'
import { boardStore } from '../../../stores/boardStore.js'
import { PropertiesPanel } from '../PropertiesPanel.js'

let seq = 0
function stroke(over: Partial<BoardObject> = {}): BoardObject {
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
    ...over,
  } as BoardObject
}

function seed(objects: BoardObject[], selection: ObjectId[]) {
  boardStore.getState().loadObjects(objects)
  boardStore.getState().setSelection(selection)
}

beforeEach(() => {
  seq = 0
  localStorage.clear()
  boardStore.setState({
    objects: new Map(),
    objectsVersion: 0,
    sortedIds: [],
    activeTool: 'select',
    selection: [],
    interaction: { type: 'IDLE' },
  })
})

afterEach(cleanup)

describe('panel context precedence', () => {
  it('is hidden for the select tool with an empty selection', () => {
    render(<PropertiesPanel />)
    expect(screen.queryByTestId('properties-panel')).toBeNull()
  })

  it('shows the selection context once something is selected', () => {
    const a = stroke()
    seed([a], [a.id])
    render(<PropertiesPanel />)

    const panel = screen.getByTestId('properties-panel')
    expect(panel.getAttribute('data-context')).toBe('selection')
    expect(within(panel).getByTestId('selection-properties')).toBeTruthy()
  })

  it('a selection OUTRANKS the active tool', () => {
    // A user who has just selected something wants to edit it; the pen's
    // swatches are not what they reached for.
    const a = stroke()
    seed([a], [a.id])
    boardStore.setState({ activeTool: 'pen' })
    render(<PropertiesPanel />)

    expect(screen.getByTestId('properties-panel').getAttribute('data-context')).toBe(
      'selection',
    )
    expect(screen.queryByTestId('pen-properties')).toBeNull()
  })

  it('shows the eraser context when the eraser is active', () => {
    boardStore.setState({ activeTool: 'eraser' })
    render(<PropertiesPanel />)
    expect(screen.getByTestId('eraser-properties')).toBeTruthy()
  })
})

describe('"Mixed" — FLOWS §14.4', () => {
  it('shows a shared value plainly when the selection agrees', () => {
    const a = stroke({ color: '#EF4444', strokeWidth: 4 })
    const b = stroke({ color: '#EF4444', strokeWidth: 4 })
    seed([a, b], [a.id, b.id])
    render(<PropertiesPanel />)

    expect(screen.queryByTestId('mixed-value')).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Colour #EF4444' }).getAttribute('aria-pressed'),
    ).toBe('true')
  })

  it('renders "Mixed" when the selection disagrees on colour', () => {
    const a = stroke({ color: '#EF4444' })
    const b = stroke({ color: '#3B82F6' })
    seed([a, b], [a.id, b.id])
    render(<PropertiesPanel />)

    expect(screen.getAllByTestId('mixed-value').length).toBeGreaterThan(0)
    // No swatch may claim to be the selected one — that would tell the user
    // the whole selection is red when only half of it is.
    for (const button of screen.getAllByRole('button')) {
      const label = button.getAttribute('aria-label') ?? ''
      if (label.startsWith('Colour ')) {
        expect(button.getAttribute('aria-pressed')).toBe('false')
      }
    }
  })

  it('renders "Mixed" when the selection disagrees on width', () => {
    const a = stroke({ strokeWidth: 2 })
    const b = stroke({ strokeWidth: 12 })
    seed([a, b], [a.id, b.id])
    render(<PropertiesPanel />)

    expect((screen.getByTestId('selection-width-slider') as HTMLInputElement).value).toBe(
      '1',
    )
    expect(screen.getAllByTestId('mixed-value').length).toBeGreaterThan(0)
  })

  it('renders "Mixed" for differing opacity, the universally shared property', () => {
    const a = stroke({ opacity: 1 })
    const b = stroke({ opacity: 0.5 })
    seed([a, b], [a.id, b.id])
    render(<PropertiesPanel />)
    expect(screen.getAllByTestId('mixed-value').length).toBeGreaterThan(0)
  })
})

describe('editing a selection', () => {
  it('applies a colour to every selected object at once', async () => {
    const user = userEvent.setup()
    const a = stroke({ color: '#18181B' })
    const b = stroke({ color: '#EF4444' })
    seed([a, b], [a.id, b.id])
    render(<PropertiesPanel />)

    await user.click(screen.getByRole('button', { name: 'Colour #22C55E' }))

    const objects = boardStore.getState().objects
    expect((objects.get(a.id) as { color: string }).color).toBe('#22C55E')
    expect((objects.get(b.id) as { color: string }).color).toBe('#22C55E')
  })

  it('deletes the selection', async () => {
    const user = userEvent.setup()
    const a = stroke()
    const b = stroke()
    seed([a, b], [a.id, b.id])
    render(<PropertiesPanel />)

    await user.click(screen.getByTestId('selection-delete'))

    expect(boardStore.getState().objects.size).toBe(0)
    expect(boardStore.getState().selection).toEqual([])
  })

  it('labels the count in singular and plural', () => {
    const a = stroke()
    seed([a], [a.id])
    const { unmount } = render(<PropertiesPanel />)
    expect(screen.getByTestId('selection-properties').textContent).toContain('1 object')
    unmount()

    const b = stroke()
    seed([a, b], [a.id, b.id])
    render(<PropertiesPanel />)
    expect(screen.getByTestId('selection-properties').textContent).toContain('2 objects')
  })
})
