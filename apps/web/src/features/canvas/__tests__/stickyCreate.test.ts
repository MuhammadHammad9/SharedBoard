import { beforeEach, describe, expect, it } from 'vitest'
import { MIN_OBJECT_SIZE, STICKY_DEFAULT_SIZE, type StickyObject } from '@coboard/shared'
import { boardStore } from '../../../stores/boardStore.js'
import { history } from '../history/history.js'
import {
  STICKY_DRAG_SLOP_PX,
  beginCreate,
  buildObject,
  cancelCreate,
  endCreate,
  updateCreate,
} from '../interaction/handlers/create.js'

/**
 * FR-CANVAS-008 — "Click to place a fixed 200×200 note; or drag to define a
 * custom size." Both paths enter text-edit mode at once, and neither records
 * history until the editor closes on something worth keeping.
 */

beforeEach(() => {
  boardStore.getState().resetBoard()
  history.clear()
})

/** Press at (x, y), optionally drag to (toX, toY), release. */
function press(x: number, y: number, toX = x, toY = y, shift = false) {
  expect(beginCreate(1, 'sticky', x, y)).toBe(true)
  if (toX !== x || toY !== y) updateCreate(toX, toY, shift, false)
  return endCreate(null) as StickyObject | null
}

describe('sticky note placement — FR-CANVAS-008', () => {
  it('a click places the default 200×200 note centred on the press', () => {
    const note = press(500, 300)!
    expect(note.type).toBe('sticky')
    expect(note.width).toBe(STICKY_DEFAULT_SIZE)
    expect(note.height).toBe(STICKY_DEFAULT_SIZE)
    expect(note.x).toBe(500 - STICKY_DEFAULT_SIZE / 2)
    expect(note.y).toBe(300 - STICKY_DEFAULT_SIZE / 2)
  })

  it('a drag defines a custom size, anchored where the drag began', () => {
    const note = press(100, 100, 420, 260)!
    expect(note).toMatchObject({ x: 100, y: 100, width: 320, height: 160 })
  })

  it('a drag up and to the left gives the same box', () => {
    const note = press(420, 260, 100, 100)!
    expect(note).toMatchObject({ x: 100, y: 100, width: 320, height: 160 })
  })

  it('Shift constrains the drag to a square', () => {
    const note = press(0, 0, 300, 120, true)!
    expect(note.width).toBe(note.height)
  })

  it('a hand tremor is still a click — the slop is in SCREEN pixels', () => {
    // At 25% zoom, 20 canvas units is 5 screen px: under the slop, so a click.
    boardStore.setState({ viewport: { x: 0, y: 0, zoom: 0.25 } })
    const note = press(1000, 1000, 1020, 1004)!
    expect(note.width).toBe(STICKY_DEFAULT_SIZE)
    expect(20 * 0.25).toBeLessThan(STICKY_DRAG_SLOP_PX)
  })

  it('a thin drag is never under the 8×8 minimum — FR-CANVAS-012', () => {
    const note = press(0, 0, 300, 2)!
    expect(note.width).toBe(300)
    expect(note.height).toBe(MIN_OBJECT_SIZE)
  })

  it('both paths go straight into edit mode, with the note selected', () => {
    const clicked = press(0, 0)!
    expect(boardStore.getState().editingTextId).toBe(clicked.id)
    boardStore.getState().endTextEdit()
    boardStore.getState().resetBoard()

    const dragged = press(0, 0, 300, 300)!
    const state = boardStore.getState()
    expect(state.editingTextId).toBe(dragged.id)
    expect(state.selection).toEqual([dragged.id])
    expect(state.objects.get(dragged.id)).toBeDefined()
  })

  it('records no history until the editor commits — one entry per note', () => {
    press(0, 0, 300, 300)
    expect(history.canUndo()).toBe(false)
  })

  it('a cancelled drag (pointercancel) creates nothing', () => {
    beginCreate(1, 'sticky', 0, 0)
    updateCreate(300, 300, false, false)
    cancelCreate(null)
    expect(boardStore.getState().objects.size).toBe(0)
    expect(boardStore.getState().interaction.type).toBe('IDLE')
  })

  it('the drag preview is built by the same factory as the note', () => {
    const preview = buildObject(
      'sticky',
      { x: 0, y: 0, width: 50, height: 60 },
      'x' as never,
    )
    expect(preview).toMatchObject({
      type: 'sticky',
      width: 50,
      height: 60,
      fontSize: 'auto',
    })
  })
})
