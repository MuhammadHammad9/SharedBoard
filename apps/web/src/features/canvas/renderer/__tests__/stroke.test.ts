import { describe, expect, it, vi } from 'vitest'
import { POLYLINE_ZOOM_THRESHOLD, type BoardObject, type StrokeObject } from '@coboard/shared'
import { drawStroke, strokePath, strokeStyleKey } from '../shapes/stroke.js'
import { drawObjects } from '../drawObjects.js'

/**
 * Stroke rendering — TRD §7.5, R-CANVAS-027, R-CANVAS-031, and defect D-5.
 *
 * The batching suite at the bottom is the one worth reading twice: it pins the
 * resolution of D-5, where TRD §7.6's "sort by style" advice would have broken
 * z-order if taken literally.
 */

/** Records the call sequence, so ORDER can be asserted and not just counts. */
function recorder() {
  const ops: string[] = []
  const styles: string[] = []
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(() => void ops.push('beginPath')),
    moveTo: vi.fn((x: number, y: number) => void ops.push(`moveTo(${x},${y})`)),
    lineTo: vi.fn((x: number, y: number) => void ops.push(`lineTo(${x},${y})`)),
    quadraticCurveTo: vi.fn(
      (cx: number, cy: number, x: number, y: number) =>
        void ops.push(`quad(${cx},${cy},${x},${y})`),
    ),
    stroke: vi.fn(() => void ops.push('stroke')),
    fillRect: vi.fn((x: number) => void ops.push(`fillRect(${x})`)),
    set strokeStyle(v: string) {
      styles.push(v)
      ops.push(`strokeStyle=${v}`)
    },
    get strokeStyle() {
      return styles[styles.length - 1] ?? ''
    },
    fillStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    lineCap: 'butt' as CanvasLineCap,
    lineJoin: 'miter' as CanvasLineJoin,
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops, styles }
}

const stroke = (i: number, over: Partial<StrokeObject> = {}): StrokeObject =>
  ({
    id: `${i}`.padStart(8, '0') + '-0000-4000-8000-000000000000',
    type: 'stroke',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    zIndex: `a${`${i}`.padStart(6, '0')}`,
    opacity: 1,
    createdBy: 'test',
    createdAt: 0,
    updatedAt: 0,
    points: [0, 0, 0.5, 20, 20, 0.5, 40, 0, 0.5],
    color: '#18181B',
    strokeWidth: 3,
    simplified: true,
    ...over,
  }) as StrokeObject

describe('strokePath — TRD §7.5', () => {
  it('draws nothing for fewer than two points', () => {
    const { ctx, ops } = recorder()
    strokePath(ctx, [], false)
    strokePath(ctx, [1, 2, 0.5], false)
    expect(ops).toEqual([])
  })

  it('uses quadratic curves through midpoints, not straight segments', () => {
    const { ctx, ops } = recorder()
    // Three samples: (0,0) (20,20) (40,0).
    strokePath(ctx, [0, 0, 0.5, 20, 20, 0.5, 40, 0, 0.5], false)

    expect(ops).toEqual([
      'beginPath',
      'moveTo(0,0)',
      // Control point is the raw sample; endpoint is the midpoint to the next.
      'quad(20,20,30,10)',
      // R-CANVAS-031: the path closes on the TRUE final point. Without this
      // every stroke would visibly end half a sample early.
      'lineTo(40,0)',
      'stroke',
    ])
  })

  it('falls back to straight segments below 25% zoom — R-CANVAS-027', () => {
    const { ctx, ops } = recorder()
    strokePath(ctx, [0, 0, 0.5, 20, 20, 0.5, 40, 0, 0.5], true)

    expect(ops).toEqual(['beginPath', 'moveTo(0,0)', 'lineTo(20,20)', 'lineTo(40,0)', 'stroke'])
    expect(ops.some(o => o.startsWith('quad'))).toBe(false)
  })

  it('issues exactly one stroke() per object regardless of point count', () => {
    // The reason pressure is captured but not rendered as width: variable
    // width would mean one stroke() per SEGMENT, which is R-CANVAS-022's
    // failure mode multiplied by every point in every object.
    const { ctx, ops } = recorder()
    const many = Array.from({ length: 300 }, (_, i) => [i, i % 7, 0.5]).flat()
    strokePath(ctx, many, false)
    expect(ops.filter(o => o === 'stroke')).toHaveLength(1)
  })
})

describe('drawStroke', () => {
  it('sets round caps and joins, and restores globalAlpha', () => {
    const { ctx } = recorder()
    drawStroke(ctx, { points: [0, 0, 0.5, 10, 10, 0.5], color: '#EF4444', strokeWidth: 8, opacity: 0.5 }, 1)
    expect(ctx.lineCap).toBe('round')
    expect(ctx.lineJoin).toBe('round')
    expect(ctx.lineWidth).toBe(8)
    // Left at 1 so the next unrelated draw is not silently translucent.
    expect(ctx.globalAlpha).toBe(1)
  })

  it('picks the coarse path from the zoom it is given', () => {
    const { ctx, ops } = recorder()
    drawStroke(
      ctx,
      { points: [0, 0, 0.5, 10, 10, 0.5, 20, 0, 0.5], color: '#000000', strokeWidth: 1, opacity: 1 },
      POLYLINE_ZOOM_THRESHOLD - 0.01,
    )
    expect(ops.some(o => o.startsWith('quad'))).toBe(false)
  })
})

describe('strokeStyleKey', () => {
  it('separates strokes that differ in any styled property', () => {
    const base = { color: '#18181B', strokeWidth: 3, opacity: 1 }
    expect(strokeStyleKey(base)).toBe(strokeStyleKey({ ...base }))
    expect(strokeStyleKey(base)).not.toBe(strokeStyleKey({ ...base, color: '#EF4444' }))
    expect(strokeStyleKey(base)).not.toBe(strokeStyleKey({ ...base, strokeWidth: 4 }))
    expect(strokeStyleKey(base)).not.toBe(strokeStyleKey({ ...base, opacity: 0.5 }))
  })
})

describe('drawObjects — run-length batching, defect D-5', () => {
  const args = (objects: BoardObject[]) => ({
    viewport: { x: 0, y: 0, zoom: 1 },
    width: 800,
    height: 600,
    dpr: 1,
    objects,
    scratch: [] as BoardObject[],
  })

  it('sets strokeStyle ONCE for a run of same-styled strokes', () => {
    const { ctx, styles } = recorder()
    const run = Array.from({ length: 20 }, (_, i) => stroke(i))
    drawObjects(ctx, args(run))
    // Twenty strokes, one context write. This is the whole point of batching:
    // context state changes are ~40% of frame cost at 5,000 objects.
    expect(styles).toEqual(['#18181B'])
  })

  it('sets strokeStyle once per run when styles alternate', () => {
    const { ctx, styles } = recorder()
    const alternating = [
      stroke(0, { color: '#18181B' }),
      stroke(1, { color: '#EF4444' }),
      stroke(2, { color: '#18181B' }),
      stroke(3, { color: '#EF4444' }),
    ]
    drawObjects(ctx, args(alternating))
    // Worst case degrades to one write per object, which is correct — and is
    // the price of not reordering. See the z-order test below.
    expect(styles).toEqual(['#18181B', '#EF4444', '#18181B', '#EF4444'])
  })

  it('DRAWS IN THE GIVEN Z-ORDER, never reordered by style — R-CONV-009 / D-5', () => {
    /*
     * The regression test for defect D-5.
     *
     * TRD §7.6 says to "sort visible objects by strokeStyle and set the
     * context property only when it changes". Sorting would group these into
     * black, black, red — and the red stroke, which the user drew LAST and
     * expects on top, would render underneath. The data would agree across
     * clients while the pixels disagreed, which is the worst class of bug in
     * this project because the convergence hash would not catch it.
     */
    const { ctx, ops } = recorder()
    const zOrdered = [
      stroke(0, { color: '#18181B', points: [0, 0, 0.5, 1, 1, 0.5] }),
      stroke(1, { color: '#EF4444', points: [2, 2, 0.5, 3, 3, 0.5] }),
      stroke(2, { color: '#18181B', points: [4, 4, 0.5, 5, 5, 0.5] }),
    ]
    drawObjects(ctx, args(zOrdered))

    const moves = ops.filter(o => o.startsWith('moveTo'))
    expect(moves).toEqual(['moveTo(0,0)', 'moveTo(2,2)', 'moveTo(4,4)'])
  })

  it('still blockout-renders the types that have no real renderer yet', () => {
    const { ctx, ops } = recorder()
    const mixed = [
      stroke(0, { points: [0, 0, 0.5, 5, 5, 0.5] }),
      { ...stroke(1), type: 'rect', x: 10 } as unknown as BoardObject,
    ]
    drawObjects(ctx, args(mixed))
    expect(ops).toContain('fillRect(10)')
  })

  it('culls before drawing, so an off-screen stroke costs nothing', () => {
    const { ctx, ops } = recorder()
    drawObjects(ctx, args([stroke(0, { x: 90_000, y: 90_000 })]))
    expect(ops).toEqual([])
  })
})
