/**
 * @vitest-environment happy-dom
 *
 * FR-CANVAS-019 — "Change colour" in the right-click menu (D-25).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  PEN_COLOURS,
  STICKY_COLOURS,
  type BoardObject,
  type ObjectId,
} from '@coboard/shared'
import { boardStore } from '../../../stores/boardStore.js'
import { history } from '../../../features/canvas/history/history.js'
import { colourTargetFor } from '../../../features/canvas/interaction/handlers/changeColour.js'
import { ContextMenu } from '../ContextMenu.js'
import { boardChrome } from '../../../lib/strings.js'

let seq = 0
const id = () =>
  (`${++seq}`.padStart(8, '0') + '-0000-4000-8000-000000000000') as ObjectId

const base = (x = 0) => ({
  id: id(),
  x,
  y: 0,
  width: 200,
  height: 200,
  rotation: 0,
  zIndex: `a${`${seq}`.padStart(6, '0')}`,
  opacity: 1,
  createdBy: 'test',
  createdAt: 0,
  updatedAt: 0,
})

const sticky = (x = 0): BoardObject =>
  ({
    ...base(x),
    type: 'sticky',
    text: 'Ship it',
    color: STICKY_COLOURS.yellow,
    fontSize: 'auto',
    textAlign: 'center',
  }) as BoardObject

const rect = (x = 0): BoardObject =>
  ({
    ...base(x),
    type: 'rect',
    stroke: '#18181B',
    strokeWidth: 2,
    fill: 'none',
    cornerRadius: 0,
  }) as BoardObject

const image = (x = 0): BoardObject =>
  ({
    ...base(x),
    type: 'image',
    url: 'https://example.com/a.png',
    naturalWidth: 400,
    naturalHeight: 400,
    cornerRadius: 0,
  }) as BoardObject

beforeEach(() => {
  seq = 0
  history.clear()
  boardStore.getState().resetBoard()
})
afterEach(cleanup)

describe('colourTargetFor — which palette, D-25', () => {
  it('sticky notes get the 8 frozen sticky colours', () => {
    const target = colourTargetFor([sticky()])!
    expect(target.palette.map(p => p.value)).toEqual(Object.values(STICKY_COLOURS))
    expect(target.current).toBe(STICKY_COLOURS.yellow)
  })

  it('shapes, strokes and text get the pen palette', () => {
    const target = colourTargetFor([rect()])!
    expect(target.palette.map(p => p.value)).toEqual([...PEN_COLOURS])
  })

  it('offers nothing for an image, or for notes mixed with other types', () => {
    expect(colourTargetFor([image()])).toBeNull()
    expect(colourTargetFor([sticky(), rect(300)])).toBeNull()
  })

  it('reports no current colour when the selection disagrees', () => {
    const a = rect()
    const b = { ...rect(300), stroke: '#EF4444' } as BoardObject
    expect(colourTargetFor([a, b])!.current).toBeUndefined()
  })
})

function openMenuOn(objects: BoardObject[], selection: ObjectId[]) {
  boardStore.getState().loadObjects(objects)
  boardStore.getState().setSelection(selection)
  const container = document.createElement('div')
  document.body.appendChild(container)
  render(
    <ContextMenu container={container} getSize={() => ({ width: 800, height: 600 })} />,
  )
  act(() => {
    container.dispatchEvent(
      new MouseEvent('contextmenu', { clientX: 50, clientY: 50, bubbles: true }),
    )
  })
}

describe('the "Change colour" item — FR-CANVAS-019', () => {
  it('recolours a sticky note from the frozen palette, as ONE undo entry', () => {
    const note = sticky()
    openMenuOn([note], [note.id])

    fireEvent.click(
      screen.getByRole('menuitem', { name: boardChrome.contextMenu.changeColour }),
    )
    // The menu becomes the palette, anchored where it was.
    expect(screen.getByTestId('context-menu').getAttribute('data-view')).toBe('colour')
    expect(screen.getAllByRole('button')).toHaveLength(8)

    fireEvent.click(screen.getByTestId(`swatch-${STICKY_COLOURS.blue.toLowerCase()}`))

    const after = boardStore.getState().objects.get(note.id)
    expect(after && after.type === 'sticky' && after.color).toBe(STICKY_COLOURS.blue)
    expect(screen.queryByTestId('context-menu')).toBeNull()

    history.undo()
    const undone = boardStore.getState().objects.get(note.id)
    expect(undone && undone.type === 'sticky' && undone.color).toBe(STICKY_COLOURS.yellow)
  })

  it("recolours a shape's stroke from the pen palette", () => {
    const shape = rect()
    openMenuOn([shape], [shape.id])
    fireEvent.click(
      screen.getByRole('menuitem', { name: boardChrome.contextMenu.changeColour }),
    )
    fireEvent.click(screen.getByTestId('swatch-#ef4444'))
    const after = boardStore.getState().objects.get(shape.id)
    expect(after && after.type === 'rect' && after.stroke).toBe('#EF4444')
  })

  it('is not offered for an image', () => {
    const picture = image()
    openMenuOn([picture], [picture.id])
    expect(screen.getByTestId('context-menu')).toBeTruthy()
    expect(
      screen.queryByRole('menuitem', { name: boardChrome.contextMenu.changeColour }),
    ).toBeNull()
  })
})
