import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientMessage } from '@coboard/shared'
import {
  CURSOR_FADE_MS,
  CURSOR_HIDE_MS,
  CURSOR_INTERPOLATE_MS,
  PRESENCE_SWEEP_IDLE_MS,
  type PresenceUser,
} from '@coboard/shared'
import { throttle } from '../../../lib/throttle.js'
import { idleOpacity, interpolateCursor } from '../interpolate.js'
import { PresenceStore } from '../presenceStore.js'
import { createPresenceEmitter } from '../send.js'
import { dedupeByUser } from '../AvatarStack.js'
import { truncateName } from '../drawPresence.js'

/**
 * Presence mechanics — TRD §10.3, §10.4, FLOWS §9.2.
 *
 * The rule underneath every test here is R-SYNC-001: presence is not an op. It
 * is never persisted, never sequenced, never acked, and dropped when offline.
 * What it IS is high-frequency — 20 Hz per user — and that is what makes the
 * throttle, the delta encoding and the interpolation load-bearing rather than
 * polish.
 */

const user = (sessionId: string, over: Partial<PresenceUser> = {}): PresenceUser => ({
  sessionId,
  userId: `user-${sessionId}`,
  guestId: null,
  name: 'Marcus Feld',
  colour: '#EF4444',
  role: 'EDITOR',
  ...over,
})

/* ── Throttling — TRD §10.3 ───────────────────────────────────────────────── */

describe('throttle', () => {
  beforeEach(() => vi.useFakeTimers())

  it('fires the first call immediately', () => {
    const fn = vi.fn()
    const t = throttle(fn, 50)
    t(1)
    // A cursor that waits 50 ms to report its first move after a pause looks
    // like a laggy connection rather than a throttled one.
    expect(fn).toHaveBeenCalledWith(1)
    vi.useRealTimers()
  })

  it('emits at most once per interval', () => {
    const fn = vi.fn()
    const t = throttle(fn, 50)
    for (let i = 0; i < 20; i++) t(i)
    expect(fn).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(60)
    // The trailing edge delivers the LAST value, not the second one.
    expect(fn).toHaveBeenCalledTimes(2)
    expect(fn).toHaveBeenLastCalledWith(19)
    vi.useRealTimers()
  })

  it('delivers the trailing call — the one a leading-only throttle drops', () => {
    const fn = vi.fn()
    const t = throttle(fn, 50)
    t('first')
    t('last')
    vi.advanceTimersByTime(60)

    /*
     * Without the trailing edge, a cursor that stops mid-gesture leaves
     * everyone else's screen showing where it was 50 ms before the user let
     * go — a pointer permanently a few pixels off its real position.
     */
    expect(fn).toHaveBeenLastCalledWith('last')
    vi.useRealTimers()
  })
})

/* ── The send side ────────────────────────────────────────────────────────── */

describe('cursor sending', () => {
  beforeEach(() => vi.useFakeTimers())

  it('skips a position that has not changed', () => {
    const send = vi.fn((_m: ClientMessage) => true)
    const emitter = createPresenceEmitter(send, 50)

    emitter.cursor(100, 100)
    expect(send).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(60)
    emitter.cursor(100, 100)
    vi.advanceTimersByTime(60)

    // A pointer held still during a drag fires constantly at one coordinate.
    // Twenty identical messages a second from someone who is not moving.
    expect(send).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('rounds to one decimal — a cursor is a pointer, not a measurement', () => {
    const send = vi.fn((_m: ClientMessage) => true)
    createPresenceEmitter(send, 50).cursor(12.34567, -8.98765)
    expect(send).toHaveBeenCalledWith({ t: 'cursor', x: 12.3, y: -9 })
    vi.useRealTimers()
  })

  it('sends stroke DELTAS, not the whole array — R-SYNC-041', () => {
    const send = vi.fn((_m: ClientMessage) => true)
    const emitter = createPresenceEmitter(send, 50)

    emitter.strokeProgress('s1', [0, 0, 1, 1, 1, 1])
    vi.advanceTimersByTime(60)
    emitter.strokeProgress('s1', [0, 0, 1, 1, 1, 1, 2, 2, 1])
    vi.advanceTimersByTime(60)

    /*
     * A 400-point stroke re-sent whole 20 times a second is roughly 100 KB/s
     * per user. The second message carries three numbers.
     */
    expect(send.mock.calls[1]![0]).toMatchObject({ pts: [2, 2, 1], done: false })
    vi.useRealTimers()
  })

  it('flushes before `done`, so no points are lost to the throttle window', () => {
    const send = vi.fn((_m: ClientMessage) => true)
    const emitter = createPresenceEmitter(send, 50)

    emitter.strokeProgress('s1', [0, 0, 1])
    emitter.strokeProgress('s1', [0, 0, 1, 5, 5, 1])
    emitter.strokeDone('s1')

    const sent = send.mock.calls.map(c => c[0] as { pts?: number[]; done?: boolean })
    // The final points went out, and the done message cleared the preview.
    expect(sent.some(m => m.pts?.includes(5))).toBe(true)
    expect(sent.at(-1)).toMatchObject({ done: true })
    vi.useRealTimers()
  })

  it('gives a second stroke its own delta offset', () => {
    const send = vi.fn((_m: ClientMessage) => true)
    const emitter = createPresenceEmitter(send, 50)

    emitter.strokeProgress('s1', [0, 0, 1, 1, 1, 1])
    emitter.strokeDone('s1')
    vi.advanceTimersByTime(60)
    emitter.strokeProgress('s2', [9, 9, 1])

    // Inheriting s1's offset would make s2's first delta empty and its stroke
    // start three points late.
    expect(send.mock.calls.at(-1)![0]).toMatchObject({ id: 's2', pts: [9, 9, 1] })
    vi.useRealTimers()
  })
})

/* ── Interpolation — TRD §10.4 ────────────────────────────────────────────── */

describe('cursor interpolation', () => {
  const cursor = {
    sessionId: 'them',
    x: 100,
    y: 200,
    prevX: 0,
    prevY: 0,
    updatedAt: 1_000,
  }

  it('starts at the previous position and reaches the target at exactly 50 ms', () => {
    expect(interpolateCursor(cursor, 1_000)).toMatchObject({ x: 0, y: 0 })
    expect(interpolateCursor(cursor, 1_000 + CURSOR_INTERPOLATE_MS)).toMatchObject({
      x: 100,
      y: 200,
    })
  })

  it('is halfway at 25 ms — linear, with no easing wobble', () => {
    // Easing between samples of continuous motion would add a wobble that was
    // never in the original hand movement.
    expect(interpolateCursor(cursor, 1_025)).toMatchObject({ x: 50, y: 100 })
  })

  it('clamps past the target rather than overshooting', () => {
    expect(interpolateCursor(cursor, 5_000)).toMatchObject({ x: 100, y: 200 })
  })
})

describe('idle fade — FLOWS §9.2', () => {
  it('is fully opaque while active', () => {
    expect(idleOpacity(0)).toBe(1)
    expect(idleOpacity(CURSOR_FADE_MS - 1)).toBe(1)
  })

  it('settles at 40% after the 5 s fade', () => {
    expect(idleOpacity(CURSOR_FADE_MS + 400)).toBeCloseTo(0.4, 2)
  })

  it('is gone at 15 s', () => {
    // The avatar stays in the header. A cursor parked in the middle of the
    // board by someone who wandered off is noise the reader keeps dismissing.
    expect(idleOpacity(CURSOR_HIDE_MS)).toBe(0)
  })

  it('ramps rather than stepping, at both thresholds', () => {
    // A snap from 100% to 40% reads as a glitch.
    expect(idleOpacity(CURSOR_FADE_MS + 150)).toBeGreaterThan(0.4)
    expect(idleOpacity(CURSOR_FADE_MS + 150)).toBeLessThan(1)
    expect(idleOpacity(CURSOR_HIDE_MS - 150)).toBeGreaterThan(0)
    expect(idleOpacity(CURSOR_HIDE_MS - 150)).toBeLessThan(0.4)
  })
})

/* ── The store ────────────────────────────────────────────────────────────── */

describe('PresenceStore', () => {
  let store: PresenceStore
  beforeEach(() => {
    store = new PresenceStore()
    store.setOwnSession('me')
  })

  it('ignores your own cursor, selection and strokes', () => {
    store.moveCursor('me', 1, 1)
    store.setSelection('me', ['a' as never])
    store.appendStroke('me', 's', [0, 0, 1], false)

    expect(store.allCursors()).toEqual([])
    expect(store.allSelections()).toEqual([])
    expect(store.allStrokes()).toEqual([])
  })

  it('keeps the previous position so the gap can be interpolated', () => {
    store.moveCursor('them', 10, 10)
    store.moveCursor('them', 30, 40)
    const [cursor] = store.allCursors()

    // Without the previous position there is nothing to interpolate FROM and
    // every cursor teleports between samples.
    expect(cursor).toMatchObject({ prevX: 10, prevY: 10, x: 30, y: 40 })
  })

  it('accumulates stroke deltas into the full array', () => {
    store.appendStroke('them', 's1', [0, 0, 1], false)
    store.appendStroke('them', 's1', [1, 1, 1], false)
    store.appendStroke('them', 's1', [2, 2, 1], false)

    expect(store.allStrokes()[0]!.points).toEqual([0, 0, 1, 1, 1, 1, 2, 2, 1])
  })

  it('clears the preview on `done`', () => {
    store.appendStroke('them', 's1', [0, 0, 1], false)
    store.appendStroke('them', 's1', [], true)

    // The committed object arrives separately as an op; leaving the preview up
    // would double-draw the stroke for a frame.
    expect(store.allStrokes()).toEqual([])
  })

  it('drops everything belonging to a session that left — R-PERF-023', () => {
    store.join(user('them'))
    store.moveCursor('them', 5, 5)
    store.setSelection('them', ['x' as never])
    store.appendStroke('them', 's1', [0, 0, 1], false)

    store.leave('them')

    // A cursor left behind by a departed user is a ghost that never moves.
    expect(store.allCursors()).toEqual([])
    expect(store.allSelections()).toEqual([])
    expect(store.allStrokes()).toEqual([])
    expect(store.snapshot().users).toEqual([])
  })

  it('sweeps stale cursors the leave broadcast never arrived for', () => {
    const t0 = 1_000_000
    store.moveCursor('them', 1, 1, t0)
    store.sweep(t0 + PRESENCE_SWEEP_IDLE_MS + 1)
    expect(store.allCursors()).toEqual([])
  })

  it('bumps the roster version on join and leave, but NOT on cursor movement', () => {
    const first = store.snapshot().version
    store.join(user('them'))
    const afterJoin = store.snapshot().version
    expect(afterJoin).toBeGreaterThan(first)

    for (let i = 0; i < 50; i++) store.moveCursor('them', i, i)

    /*
     * The header subscribes to this version. If cursor movement bumped it, a
     * room of ten would re-render the React tree 200 times a second to move
     * pixels React does not draw (R-ARCH-003).
     */
    expect(store.snapshot().version).toBe(afterJoin)
  })

  it('returns a STABLE snapshot reference between roster changes', () => {
    store.join(user('them'))
    // useSyncExternalStore compares by identity; a fresh array each call is an
    // infinite render loop.
    expect(store.snapshot()).toBe(store.snapshot())
  })

  it('excludes you from the roster it hands React', () => {
    store.replaceRoster([user('me'), user('them')])
    expect(store.snapshot().users.map(u => u.sessionId)).toEqual(['them'])
  })
})

/* ── Avatars — E-01, E-20 ─────────────────────────────────────────────────── */

describe('avatar rules', () => {
  it('E-01: two sessions of one user collapse to one avatar', () => {
    const merged = dedupeByUser([
      user('tab-1', { userId: 'marcus' }),
      user('tab-2', { userId: 'marcus' }),
    ])
    expect(merged).toHaveLength(1)
  })

  it('keeps two guests apart — they really are two people as far as we know', () => {
    const guests = dedupeByUser([
      user('g1', { userId: null, guestId: 'a' }),
      user('g2', { userId: null, guestId: 'b' }),
    ])
    expect(guests).toHaveLength(2)
  })

  it('E-20: truncates a long name to 20 characters with an ellipsis', () => {
    expect(truncateName('Bartholomew Fotheringay-Smythe')).toBe('Bartholomew Fotheri…')
    // A name that fits is left alone — no ellipsis on "Priya Raman".
    expect(truncateName('Priya Raman')).toBe('Priya Raman')
    expect(truncateName('x'.repeat(30))).toHaveLength(20)
  })
})
