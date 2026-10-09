import { beforeEach, describe, expect, it } from 'vitest'
import type { ObjectId } from '@coboard/shared'
import { boardStore } from '../../../stores/boardStore.js'
import { createTouchTracker } from '../interaction/touchGestures.js'

/** FLOWS §14.5 — pinch zoom/pan and long-press multi-select. */

const ev = (pointerId: number, timeStamp = 0, pointerType = 'touch') =>
  ({ pointerId, timeStamp, pointerType }) as unknown as PointerEvent

beforeEach(() => {
  boardStore.getState().setViewport({ x: 0, y: 0, zoom: 1 })
})

describe('pinch', () => {
  it('the second finger starts a pinch; a mouse never does', () => {
    const t = createTouchTracker()
    expect(t.down(ev(1, 0, 'mouse'), { x: 0, y: 0 })).toBe(false)
    expect(t.down(ev(2), { x: 100, y: 100 })).toBe(false)
    expect(t.down(ev(3), { x: 200, y: 100 })).toBe(true)
    expect(t.pinching).toBe(true)
  })

  it('spreading two fingers zooms about their midpoint', () => {
    const t = createTouchTracker()
    t.down(ev(1), { x: 100, y: 100 })
    t.down(ev(2), { x: 200, y: 100 })
    // Distance 100 → 200, midpoint still (150, 100): zoom ×2 about it.
    t.move(ev(1), { x: 50, y: 100 })
    t.move(ev(2), { x: 250, y: 100 })
    const v = boardStore.getState().viewport
    expect(v.zoom).toBeCloseTo(2, 5)
    // The canvas point under the midpoint did not move.
    expect((150 - v.x) / v.zoom).toBeCloseTo(150, 5)
  })

  it('lifting one finger ends the pinch', () => {
    const t = createTouchTracker()
    t.down(ev(1), { x: 0, y: 0 })
    t.down(ev(2), { x: 10, y: 0 })
    expect(t.up(ev(2))).toBe(true)
    expect(t.pinching).toBe(false)
  })
})

describe('long-press', () => {
  const a = 'a' as ObjectId
  const b = 'b' as ObjectId

  it('held still for 500 ms toggles the object into the earlier selection', () => {
    const t = createTouchTracker()
    t.down(ev(1, 0), { x: 10, y: 10 })
    t.notePress(ev(1, 0), b, [a], { x: 10, y: 10 })
    expect(t.takeLongPress(ev(1, 600))).toEqual([a, b])
  })

  it('a quick tap is not a long-press', () => {
    const t = createTouchTracker()
    t.down(ev(1, 0), { x: 10, y: 10 })
    t.notePress(ev(1, 0), b, [a], { x: 10, y: 10 })
    expect(t.takeLongPress(ev(1, 200))).toBeNull()
  })

  it('moving past the slop makes it a drag, not a long-press', () => {
    const t = createTouchTracker()
    t.down(ev(1, 0), { x: 10, y: 10 })
    t.notePress(ev(1, 0), b, [], { x: 10, y: 10 })
    t.move(ev(1, 100), { x: 40, y: 10 })
    expect(t.takeLongPress(ev(1, 700))).toBeNull()
  })

  it('long-pressing an already selected object takes it out', () => {
    const t = createTouchTracker()
    t.down(ev(1, 0), { x: 10, y: 10 })
    t.notePress(ev(1, 0), b, [a, b], { x: 10, y: 10 })
    expect(t.takeLongPress(ev(1, 600))).toEqual([a])
  })
})
