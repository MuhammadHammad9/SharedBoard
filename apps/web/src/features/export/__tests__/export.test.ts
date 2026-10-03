import { describe, expect, it } from 'vitest'
import type { BoardObject } from '@coboard/shared'
import { clampScale, exportContent } from '../renderToCanvas.js'
import { exportFilename, slugify } from '../download.js'

/** FLOWS §11, FR-EXPORT-001 — bounds per scope, the clamp, the file name. */

const box = (id: string, x: number, y: number, width = 100, height = 50) =>
  ({ id, type: 'rect', x, y, width, height, rotation: 0 }) as BoardObject

const objects = [box('a', 0, 0), box('b', 300, 200), box('c', 5_000, 5_000)]
const view = { x: -50, y: -50, width: 500, height: 400 }

describe('exportContent', () => {
  it('whole board: every object, the union of their bounds plus padding', () => {
    const found = exportContent('board', objects, new Set(), view, 24)!
    expect(found.objects.map(o => o.id)).toEqual(['a', 'b', 'c'])
    expect(found.rect).toEqual({ x: -24, y: -24, width: 5_148, height: 5_098 })
  })

  it('selection: only the selected objects, their bounds plus padding', () => {
    const found = exportContent('selection', objects, new Set(['b']), view, 10)!
    expect(found.objects.map(o => o.id)).toEqual(['b'])
    expect(found.rect).toEqual({ x: 290, y: 190, width: 120, height: 70 })
  })

  it('visible area: the objects touching the view, framed by the view itself', () => {
    const found = exportContent('visible', objects, new Set(), view, 24)!
    expect(found.objects.map(o => o.id)).toEqual(['a', 'b'])
    expect(found.rect).toEqual(view)
  })

  it('keeps z-order', () => {
    const found = exportContent('board', [objects[2]!, objects[0]!], new Set(), view, 0)!
    expect(found.objects.map(o => o.id)).toEqual(['c', 'a'])
  })

  it('E-22: nothing in scope is null — an empty board, an empty selection', () => {
    expect(exportContent('board', [], new Set(), view, 24)).toBeNull()
    expect(exportContent('selection', objects, new Set(), view, 24)).toBeNull()
    expect(
      exportContent(
        'visible',
        objects,
        new Set(),
        { x: 9e4, y: 9e4, width: 10, height: 10 },
        0,
      ),
    ).toBeNull()
  })
})

describe('clampScale — the 8192² limit', () => {
  it('leaves a scale that fits alone', () => {
    expect(clampScale({ x: 0, y: 0, width: 2_000, height: 1_000 }, 2)).toEqual({
      scale: 2,
      clamped: false,
    })
  })

  it('reduces the scale to fit and reports it', () => {
    const rect = { x: 0, y: 0, width: 10_000, height: 10_000 }
    const { scale, clamped } = clampScale(rect, 2)
    expect(clamped).toBe(true)
    expect(rect.width * scale * rect.height * scale).toBeLessThanOrEqual(
      8_192 * 8_192 + 1,
    )
    expect(scale).toBeCloseTo(0.8192, 4)
  })
})

describe('the file name', () => {
  it.each([
    ['Q3 Retrospective', 'q3-retrospective'],
    ['  Café — "Plan" (v2)!  ', 'cafe-plan-v2'],
    ['Ünïcødé 看板', 'unicøde-看板'],
    ['***', 'board'],
    ['', 'board'],
  ])('%j → %s', (name, slug) => {
    expect(slugify(name)).toBe(slug)
  })

  it('is {slug}-{YYYY-MM-DD}.png in local time', () => {
    expect(exportFilename('Q3 Retrospective', new Date(2026, 9, 3, 23, 59))).toBe(
      'q3-retrospective-2026-10-03.png',
    )
  })
})
