/**
 * @vitest-environment happy-dom
 *
 * Cancelling a gesture from outside the pointer — a live demotion to viewer
 * (FLOWS §9.5) and Escape (R-CANVAS-055) share one path, and both leave the
 * board exactly as the server has it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import type { BoardObject, ObjectId } from '@coboard/shared'

const bus = vi.hoisted(() => ({ done: vi.fn() }))
vi.mock('../../presence/bus.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../presence/bus.js')>()),
  emitStrokeDone: bus.done,
}))

const { boardStore } = await import('../../../stores/boardStore.js')
const { setBoardReadOnly, setGestureElement } =
  await import('../interaction/cancelGesture.js')
const { beginDrag, updateDrag } = await import('../interaction/handlers/transform.js')
const { beginErase, eraseAt } = await import('../interaction/handlers/erase.js')
const { beginDraw, appendPoint } = await import('../interaction/handlers/draw.js')
const { beginMarquee, updateMarquee } = await import('../interaction/handlers/select.js')
const { beginPan } = await import('../interaction/handlers/pan.js')
const { useKeyboard } = await import('../interaction/useKeyboard.js')

const ID = '00000001-0000-4000-8000-000000000000' as ObjectId
const rect = (id = ID, x = 0): BoardObject =>
  ({
    id,
    type: 'rect',
    x,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    zIndex: 'a0',
    opacity: 1,
    createdBy: 'me',
    createdAt: 0,
    updatedAt: 0,
    stroke: '#18181B',
    strokeWidth: 2,
    fill: 'none',
  }) as unknown as BoardObject

let element: { releasePointerCapture: ReturnType<typeof vi.fn> }

beforeEach(() => {
  bus.done.mockReset()
  boardStore.getState().setReadOnly(false)
  boardStore.getState().resetBoard()
  boardStore.getState().loadObjects([rect()])
  element = { releasePointerCapture: vi.fn() }
  setGestureElement(element as unknown as Element)
})

afterEach(() => {
  setGestureElement(null)
  boardStore.getState().setReadOnly(false)
  cleanup()
})

describe('demotion to viewer mid-gesture — FLOWS §9.5', () => {
  it('a drag is put back, and capture released', () => {
    boardStore.getState().setSelection([ID])
    beginDrag(7, 0, 0)
    updateDrag(50, 50)
    setBoardReadOnly(true)
    const o = boardStore.getState().objects.get(ID)!
    expect([o.x, o.y]).toEqual([0, 0])
    expect(boardStore.getState().interaction.type).toBe('IDLE')
    expect(element.releasePointerCapture).toHaveBeenCalledWith(7)
  })

  it('an erase sweep is restored, not left deleted locally', () => {
    beginErase(3, 50, 50)
    expect(boardStore.getState().objects.has(ID)).toBe(false)
    setBoardReadOnly(true)
    expect(boardStore.getState().objects.has(ID)).toBe(true)
    expect(boardStore.getState().sortedIds).toEqual([ID])
    expect(element.releasePointerCapture).toHaveBeenCalledWith(3)
  })

  it('a stroke in progress withdraws its presence preview', () => {
    beginDraw(4, 10, 10, 0.5)
    appendPoint(20, 20, 0.5)
    const draftId = boardStore.getState().draft!.id
    setBoardReadOnly(true)
    expect(bus.done).toHaveBeenCalledWith(draftId)
    expect(boardStore.getState().draft).toBeNull()
    expect(element.releasePointerCapture).toHaveBeenCalledWith(4)
  })
})

describe('Escape mid-gesture — R-CANVAS-055', () => {
  const press = (key: string) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))

  beforeEach(() => {
    boardStore.getState().setActiveTool('eraser')
    renderHook(() =>
      useKeyboard({
        getSize: () => ({ width: 800, height: 600 }),
        getElement: () => element as unknown as Element,
      }),
    )
  })

  it('cancels an erase — restoring the objects — without changing the tool', () => {
    beginErase(1, 50, 50)
    eraseAt(50, 50)
    press('Escape')
    expect(boardStore.getState().objects.has(ID)).toBe(true)
    expect(boardStore.getState().interaction.type).toBe('IDLE')
    expect(boardStore.getState().activeTool).toBe('eraser')
  })

  it('cancels a marquee, restoring the prior selection, without changing the tool', () => {
    const other = '00000002-0000-4000-8000-000000000000' as ObjectId
    boardStore.getState().loadObjects([rect(), rect(other, 500)])
    boardStore.getState().setSelection([other])
    beginMarquee(1, -10, -10, true)
    updateMarquee(200, 200)
    press('Escape')
    expect(boardStore.getState().selection).toEqual([other])
    expect(boardStore.getState().interaction.type).toBe('IDLE')
    expect(boardStore.getState().activeTool).toBe('eraser')
  })

  it('ends a pan without changing the tool', () => {
    beginPan(1, 0, 0)
    press('Escape')
    expect(boardStore.getState().interaction.type).toBe('IDLE')
    expect(boardStore.getState().activeTool).toBe('eraser')
  })

  it('when IDLE, still deselects and returns to Select', () => {
    boardStore.getState().setSelection([ID])
    press('Escape')
    expect(boardStore.getState().selection).toEqual([])
    expect(boardStore.getState().activeTool).toBe('select')
  })
})
