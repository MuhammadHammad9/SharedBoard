import { describe, expect, it, vi } from 'vitest'
import type { ShapeObject } from '@coboard/shared'
import { drawShape } from '../shapes/shapes.js'

/** FLOWS §14.4 — lines and arrows both take an arrowhead style. */

function strokes(s: Partial<ShapeObject>): number {
  let count = 0
  const ctx = {
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(() => void count++),
    fill: vi.fn(),
  } as unknown as CanvasRenderingContext2D
  drawShape(ctx, {
    id: 'x',
    type: 'line',
    x: 0,
    y: 0,
    width: 100,
    height: 0,
    rotation: 0,
    zIndex: 'a0',
    opacity: 1,
    createdBy: 't',
    createdAt: 0,
    updatedAt: 0,
    stroke: '#18181B',
    strokeWidth: 2,
    fill: 'none',
    ...s,
  } as ShapeObject)
  return count
}

describe('arrowheads on lines and arrows', () => {
  it('keeps the stored defaults: a plain line has no head, an arrow one', () => {
    expect(strokes({ type: 'line' })).toBe(1)
    expect(strokes({ type: 'arrow' })).toBe(2)
  })

  it('draws the heads a line or arrow asks for', () => {
    expect(strokes({ type: 'line', arrowEnd: true })).toBe(2)
    expect(strokes({ type: 'line', arrowStart: true, arrowEnd: true })).toBe(3)
    expect(strokes({ type: 'arrow', arrowStart: false, arrowEnd: false })).toBe(1)
  })
})
