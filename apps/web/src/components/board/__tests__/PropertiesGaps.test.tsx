/**
 * @vitest-environment happy-dom
 *
 * FLOWS §14.4 rows the selection panel was missing — fill and corner radius
 * (FR-CANVAS-007), bold / italic / alignment (FR-CANVAS-009), arrowheads,
 * the sticky font auto/manual toggle, z-order (FR-CANVAS-016), and image
 * corner radius + "Reset size".
 *
 * Every control goes through the existing UPDATE path: ONE op per object
 * carrying ONLY the changed keys, and ONE undo entry per change.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  STICKY_COLOURS,
  type BoardObject,
  type ClientOp,
  type ObjectId,
} from '@coboard/shared'
import { boardStore } from '../../../stores/boardStore.js'
import { history } from '../../../features/canvas/history/history.js'
import { PropertiesPanel } from '../PropertiesPanel.js'
import { arrowheadsOf } from '../../../features/canvas/arrowheads.js'

const emitted = vi.hoisted(() => [] as ClientOp[][])
vi.mock('../../../features/sync/persistence.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../features/sync/persistence.js')>()),
  emitOps: (ops: readonly ClientOp[]) => emitted.push([...ops]),
}))

let seq = 0
const base = (x = 0) => {
  seq++
  return {
    id: (`${seq}`.padStart(8, '0') + '-0000-4000-8000-000000000000') as ObjectId,
    x,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    zIndex: `a${`${seq}`.padStart(6, '0')}`,
    opacity: 1,
    createdBy: 'test',
    createdAt: 0,
    updatedAt: 0,
  }
}
const rect = (x = 0) =>
  ({
    ...base(x),
    type: 'rect',
    stroke: '#18181B',
    strokeWidth: 2,
    fill: 'none',
    cornerRadius: 0,
  }) as BoardObject
const ellipse = (x = 0) =>
  ({
    ...base(x),
    type: 'ellipse',
    stroke: '#18181B',
    strokeWidth: 2,
    fill: 'none',
  }) as BoardObject
const line = (type: 'line' | 'arrow' = 'line') =>
  ({ ...base(), type, stroke: '#18181B', strokeWidth: 2, fill: 'none' }) as BoardObject
const text = () =>
  ({
    ...base(),
    type: 'text',
    text: 'Hello',
    color: '#18181B',
    fontSize: 16,
    bold: false,
    italic: false,
    textAlign: 'left',
  }) as BoardObject
const sticky = () =>
  ({
    ...base(),
    type: 'sticky',
    text: 'Note',
    color: STICKY_COLOURS.yellow,
    fontSize: 'auto',
    textAlign: 'center',
  }) as BoardObject
const image = () =>
  ({
    ...base(),
    type: 'image',
    url: 'https://example.com/a.png',
    width: 50,
    height: 30,
    naturalWidth: 400,
    naturalHeight: 240,
    cornerRadius: 0,
  }) as BoardObject

function select(...objects: BoardObject[]) {
  boardStore.getState().loadObjects(objects)
  boardStore.getState().setSelection(objects.map(o => o.id))
  render(<PropertiesPanel />)
}

const get = (id: ObjectId) => boardStore.getState().objects.get(id)!
/** The keys of the last emitted UPDATE's payload, without the timestamp. */
const lastKeys = () =>
  Object.keys((emitted.at(-1)![0]!.payload as Record<string, unknown>) ?? {})
    .filter(k => k !== 'updatedAt')
    .sort()

beforeEach(() => {
  seq = 0
  emitted.length = 0
  localStorage.clear()
  history.clear()
  boardStore.getState().resetBoard()
  boardStore.setState({ activeTool: 'select' })
})
afterEach(cleanup)

describe('rect / ellipse — fill and corner radius', () => {
  it('fill: picks a colour, or "none", as one UPDATE of `fill` alone', () => {
    const r = rect()
    select(r)
    fireEvent.click(screen.getByLabelText('Fill colour #EF4444'))
    expect(get(r.id)).toMatchObject({ fill: '#EF4444', stroke: '#18181B' })
    expect(lastKeys()).toEqual(['fill'])

    fireEvent.click(screen.getByTestId('selection-fill-none'))
    expect(get(r.id)).toMatchObject({ fill: 'none' })
    history.undo()
    expect(get(r.id)).toMatchObject({ fill: '#EF4444' })
  })

  it('corner radius is offered for rectangles only', () => {
    const r = rect()
    select(r)
    fireEvent.change(screen.getByTestId('selection-radius-slider'), {
      target: { value: '12' },
    })
    expect(get(r.id)).toMatchObject({ cornerRadius: 12 })
    expect(lastKeys()).toEqual(['cornerRadius'])
    cleanup()

    select(ellipse(300))
    expect(screen.queryByTestId('selection-radius-slider')).toBeNull()
    expect(screen.getByTestId('selection-fill-none')).toBeTruthy()
  })
})

describe('line / arrow — arrowhead style', () => {
  it('reads the stored defaults: an arrow ends in a head, a line has none', () => {
    expect(arrowheadsOf(line('arrow'))).toBe('end')
    expect(arrowheadsOf(line('line'))).toBe('none')
  })

  it('sets start/end/both/none through the two schema booleans', () => {
    const a = line('arrow')
    select(a)
    expect(screen.getByTestId('arrowheads-end').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByTestId('arrowheads-both'))
    expect(get(a.id)).toMatchObject({ arrowStart: true, arrowEnd: true })
    expect(lastKeys()).toEqual(['arrowEnd', 'arrowStart'])
    // No fill row for a line — it has no interior.
    expect(screen.queryByTestId('selection-fill-none')).toBeNull()
  })
})

describe('text — bold, italic, alignment', () => {
  it('each toggle is one UPDATE of its own key', () => {
    const t = text()
    select(t)
    fireEvent.click(screen.getByTestId('selection-bold'))
    expect(get(t.id)).toMatchObject({ bold: true })
    expect(lastKeys()).toEqual(['bold'])

    fireEvent.click(screen.getByTestId('selection-italic'))
    expect(lastKeys()).toEqual(['italic'])

    fireEvent.click(screen.getByTestId('selection-align-right'))
    expect(get(t.id)).toMatchObject({ textAlign: 'right' })
    expect(lastKeys()).toEqual(['textAlign'])

    // Three changes, three undo entries.
    history.undo()
    history.undo()
    history.undo()
    expect(get(t.id)).toMatchObject({ bold: false, italic: false, textAlign: 'left' })
  })
})

describe('sticky — font size auto/manual', () => {
  it('turns auto off to a fixed size, and back', () => {
    const s = sticky()
    select(s)
    const toggle = screen.getByTestId('sticky-font-auto')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toggle)
    expect(get(s.id)).toMatchObject({ fontSize: 16 })
    expect(lastKeys()).toEqual(['fontSize'])
    fireEvent.change(screen.getByTestId('sticky-font-slider'), {
      target: { value: '24' },
    })
    expect(get(s.id)).toMatchObject({ fontSize: 24 })
    fireEvent.click(screen.getByTestId('sticky-font-auto'))
    expect(get(s.id)).toMatchObject({ fontSize: 'auto' })
  })
})

describe('image — corner radius and Reset size', () => {
  it('Reset size restores the natural size, anchored at the top-left', () => {
    const i = image()
    select(i)
    fireEvent.click(screen.getByTestId('selection-reset-size'))
    expect(get(i.id)).toMatchObject({ x: 0, y: 0, width: 400, height: 240 })
    expect(lastKeys()).toEqual(['height', 'width'])
    expect(screen.getByTestId('selection-radius-slider')).toBeTruthy()
  })
})

describe('z-order controls — FR-CANVAS-016', () => {
  it('bring to front moves the selection above everything, in one entry', () => {
    const a = rect()
    const b = rect(200)
    boardStore.getState().loadObjects([a, b])
    boardStore.getState().setSelection([a.id])
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('layer-front'))
    expect(boardStore.getState().sortedIds.at(-1)).toBe(a.id)
    expect(lastKeys()).toEqual(['zIndex'])
    history.undo()
    expect(boardStore.getState().sortedIds.at(-1)).toBe(b.id)
  })
})
