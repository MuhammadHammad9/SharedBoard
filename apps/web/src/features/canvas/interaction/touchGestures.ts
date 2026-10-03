import type { ObjectId } from '@coboard/shared'
import { boardStore } from '../../../stores/boardStore.js'

/**
 * Touch gestures — FLOWS §14.5, PRD §7.7 ("pinch/pan").
 *
 *   two fingers     pinch zooms about the midpoint, and the midpoint pans —
 *                   one continuous gesture, as every map app does it. A
 *                   second finger cancels whatever the first one started
 *   long-press      on an object, ≥ 500 ms without moving: toggle it into
 *                   the selection (touch has no Shift key)
 *
 * One-finger pan on empty canvas is decided by the Select router in
 * usePointer; this module only keeps the per-pointer bookkeeping.
 *
 * Plain state in a closure, not React or Zustand: it changes on every
 * pointermove and nothing renders from it (R-STATE-003).
 */

const LONG_PRESS_MS = 500
/** Movement that turns a press into a drag, in screen px. */
const SLOP_PX = 8

interface Point {
  x: number
  y: number
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const midpoint = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

export function createTouchTracker() {
  const points = new Map<number, Point>()
  let pinch: { dist: number; mid: Point } | null = null
  let press: {
    pointerId: number
    id: ObjectId
    prior: readonly ObjectId[]
    at: number
    origin: Point
    moved: boolean
  } | null = null

  const pair = (): [Point, Point] | null => {
    const [a, b] = [...points.values()]
    return a && b ? [a, b] : null
  }

  return {
    /** True when this press makes a PINCH — the caller cancels and stops. */
    down(e: PointerEvent, p: Point): boolean {
      if (e.pointerType !== 'touch') return false
      points.set(e.pointerId, p)
      if (points.size !== 2) return false
      const both = pair()!
      pinch = { dist: Math.max(1, distance(...both)), mid: midpoint(...both) }
      press = null
      return true
    },

    /** True when the move belonged to a pinch and nothing else may use it. */
    move(e: PointerEvent, p: Point): boolean {
      if (e.pointerType !== 'touch' || !points.has(e.pointerId)) return false
      points.set(e.pointerId, p)
      if (press && press.pointerId === e.pointerId && distance(p, press.origin) > SLOP_PX)
        press.moved = true
      if (!pinch) return false
      const both = pair()
      if (!both) return true
      const dist = Math.max(1, distance(...both))
      const mid = midpoint(...both)
      const store = boardStore.getState()
      store.panBy(mid.x - pinch.mid.x, mid.y - pinch.mid.y)
      store.zoomAt(mid.x, mid.y, dist / pinch.dist)
      pinch = { dist, mid }
      return true
    },

    /** True when the lifted finger was part of a pinch. */
    up(e: PointerEvent): boolean {
      if (e.pointerType !== 'touch') return false
      points.delete(e.pointerId)
      if (!pinch) return false
      if (points.size < 2) pinch = null
      return true
    },

    get pinching(): boolean {
      return pinch !== null
    },

    /** A touch press on an object: a long-press candidate. */
    notePress(e: PointerEvent, id: ObjectId, prior: readonly ObjectId[], p: Point): void {
      if (e.pointerType !== 'touch') return
      press = { pointerId: e.pointerId, id, prior, at: e.timeStamp, origin: p, moved: false }
    },

    /**
     * On release: if that press was a long-press, the selection it should
     * leave — the prior selection with the object toggled. Otherwise null.
     */
    takeLongPress(e: PointerEvent): ObjectId[] | null {
      const candidate = press
      press = null
      if (!candidate || candidate.pointerId !== e.pointerId || candidate.moved) return null
      if (e.timeStamp - candidate.at < LONG_PRESS_MS) return null
      return candidate.prior.includes(candidate.id)
        ? candidate.prior.filter(id => id !== candidate.id)
        : [...candidate.prior, candidate.id]
    },
  }
}
