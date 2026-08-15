import { describe, expect, it } from 'vitest'
import { SIMPLIFY_EPSILON, STROKE_POINTS_MAX } from '../constants.js'
import { simplifyStroke, strokeBounds } from '../geometry.js'

/**
 * Stroke geometry — TRD §7.5, R-CANVAS-032.
 *
 * These are the tests behind the phase's headline claim: "a 3-second scribble
 * commits to roughly 60 points with no visible difference".
 */

/** Build a stride-3 array from [x, y] pairs, pressure fixed at 0.5. */
const pts = (pairs: readonly (readonly [number, number])[]): number[] =>
  pairs.flatMap(([x, y]) => [x, y, 0.5])

describe('simplifyStroke — Ramer–Douglas–Peucker, ε = 0.5 canvas units', () => {
  it('returns two-point and shorter strokes untouched', () => {
    expect(simplifyStroke([])).toEqual([])
    expect(simplifyStroke([1, 2, 0.5])).toEqual([1, 2, 0.5])
    const two = pts([
      [0, 0],
      [10, 10],
    ])
    expect(simplifyStroke(two)).toEqual(two)
  })

  it('collapses a straight line to its two endpoints', () => {
    // Eleven collinear samples. Every interior point sits exactly on the
    // chord, so all nine are redundant.
    const line = pts(Array.from({ length: 11 }, (_, i) => [i * 10, i * 10] as const))
    const out = simplifyStroke(line)
    expect(out).toEqual(pts([
      [0, 0],
      [100, 100],
    ]))
  })

  it('preserves the first and last points exactly', () => {
    const raw = pts(
      Array.from({ length: 200 }, (_, i) => [i, Math.sin(i / 7) * 40] as const),
    )
    const out = simplifyStroke(raw)
    expect(out.slice(0, 3)).toEqual(raw.slice(0, 3))
    expect(out.slice(-3)).toEqual(raw.slice(-3))
  })

  it('keeps a corner that a straight-line approximation would lose', () => {
    // An L. The apex is far off the chord between the endpoints, so it must
    // survive — an RDP that dropped it would square off every sharp turn.
    const l = pts([
      [0, 0],
      [50, 0],
      [100, 0],
      [100, 50],
      [100, 100],
    ])
    const out = simplifyStroke(l)
    expect(out).toEqual(pts([
      [0, 0],
      [100, 0],
      [100, 100],
    ]))
  })

  it('carries each kept point’s own pressure through unchanged', () => {
    // Distinct pressures, an apex that must survive. The kept apex must bring
    // ITS pressure, not an interpolated or neighbouring one.
    const raw = [0, 0, 0.1, 50, 40, 0.9, 100, 0, 0.3]
    expect(simplifyStroke(raw)).toEqual(raw)

    // And when a point is dropped, the survivors keep their own values.
    const withRedundant = [0, 0, 0.1, 25, 0, 0.7, 50, 0, 0.4]
    const out = simplifyStroke(withRedundant)
    expect(out).toEqual([0, 0, 0.1, 50, 0, 0.4])
  })

  it('reduces a 3-second scribble by roughly 6× — the TRD §7.5 claim', () => {
    /*
     * ~400 samples is what 3 seconds of drawing produces at typical pointer
     * rates. The path is a smooth multi-frequency squiggle with sub-pixel
     * jitter on top, which is what a real hand produces: the jitter is the
     * redundancy RDP exists to remove.
     */
    const raw = pts(
      Array.from({ length: 400 }, (_, i) => {
        const t = i / 400
        return [
          t * 600 + Math.sin(i * 1.7) * 0.2,
          Math.sin(t * 9) * 120 + Math.cos(t * 21) * 30 + Math.cos(i * 2.3) * 0.2,
        ] as const
      }),
    )
    const out = simplifyStroke(raw, SIMPLIFY_EPSILON)
    const rawCount = raw.length / 3
    const outCount = out.length / 3

    expect(rawCount).toBe(400)
    // "Roughly 60" — a band, not a magic number, since the exact count depends
    // on the path. What matters is the order of magnitude of the saving.
    expect(outCount).toBeGreaterThan(20)
    expect(outCount).toBeLessThan(120)
    expect(rawCount / outCount).toBeGreaterThan(3)
  })

  it('never moves a kept point further than ε from the original path', () => {
    // The correctness property RDP actually guarantees, and the reason "no
    // visible difference" is a claim rather than a hope.
    const raw = pts(Array.from({ length: 120 }, (_, i) => [i * 3, Math.sin(i / 5) * 50] as const))
    const out = simplifyStroke(raw, SIMPLIFY_EPSILON)
    // Every kept point is one of the originals, unmodified.
    for (let i = 0; i < out.length; i += 3) {
      const found = raw.some(
        (_, j) => j % 3 === 0 && raw[j] === out[i] && raw[j + 1] === out[i + 1],
      )
      expect(found).toBe(true)
    }
  })

  it('handles the STROKE_POINTS_MAX ceiling without blowing the stack', () => {
    /*
     * A hostile client can send the maximum. Naive recursion on a
     * monotonically curving path recurses once per point — 10,000 frames deep
     * is a RangeError, and a crash in the shared package takes the SERVER down
     * in Phase 9, not just a tab.
     */
    const count = STROKE_POINTS_MAX / 3
    const raw: number[] = []
    for (let i = 0; i < count; i++) raw.push(i, Math.sqrt(i) * 30, 0.5)

    expect(() => simplifyStroke(raw)).not.toThrow()
    const out = simplifyStroke(raw)
    expect(out.length).toBeGreaterThanOrEqual(6)
    expect(out.length).toBeLessThan(raw.length)
  })
})

describe('strokeBounds', () => {
  it('inflates the box by half the stroke width on every side', () => {
    const box = strokeBounds(
      pts([
        [10, 20],
        [110, 220],
      ]),
      8,
    )
    // Raw extent is 100×200 at (10,20); a width-8 line paints 4 units beyond
    // the path on all sides, so the box grows by 8 in each dimension.
    expect(box).toEqual({ x: 6, y: 16, width: 108, height: 208 })
  })

  it('gives a single point a box the size of the pen nib', () => {
    expect(strokeBounds([50, 50, 0.5], 6)).toEqual({ x: 47, y: 47, width: 6, height: 6 })
  })

  it('returns a zero box for no points rather than Infinity', () => {
    // Infinity in a coordinate propagates through the renderer and blanks the
    // canvas for everyone in the room — R-SEC-004's exact failure mode.
    expect(strokeBounds([], 4)).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })
})
