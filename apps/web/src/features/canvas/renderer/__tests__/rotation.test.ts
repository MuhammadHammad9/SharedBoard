import { describe, expect, it } from 'vitest'
import type { BoardObject } from '@coboard/shared'
import { drawObjects } from '../drawObjects.js'
import { isVisible } from '../../geometry/culling.js'

/**
 * FR-CANVAS-012 — rotation is RENDERED, not only hit-tested. Before Phase 14
 * the renderer drew every object upright inside its rotated hit box.
 */

function ctx() {
  const calls: string[] = []
  const handler: ProxyHandler<Record<string, unknown>> = {
    get: (target, key) => {
      if (key in target) return target[key as string]
      return (...args: unknown[]) => {
        calls.push(
          `${String(key)}(${args
            .filter(a => typeof a === 'number')
            .map(n => (n as number).toFixed(3))
            .join(',')})`,
        )
      }
    },
    set: (target, key, value) => {
      target[key as string] = value
      return true
    },
  }
  return {
    calls,
    ctx: new Proxy(
      {} as Record<string, unknown>,
      handler,
    ) as unknown as CanvasRenderingContext2D,
  }
}

const rect = (rotation: number) =>
  ({
    id: 'r',
    type: 'rect',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    rotation,
    zIndex: 'a0',
    opacity: 1,
    stroke: '#18181B',
    strokeWidth: 2,
    fill: 'none',
    cornerRadius: 0,
  }) as unknown as BoardObject

const args = (objects: BoardObject[]) => ({
  viewport: { x: 0, y: 0, zoom: 1 },
  width: 800,
  height: 600,
  dpr: 1,
  objects,
  scratch: [],
  images: { get: () => null, status: () => undefined },
})

describe('rotation', () => {
  it('rotates a rotated object about its centre, in radians from degrees', () => {
    const { ctx: c, calls } = ctx()
    drawObjects(c, args([rect(90)]))
    const at = calls.indexOf(`rotate(${(Math.PI / 2).toFixed(3)})`)
    expect(at).toBeGreaterThan(-1)
    expect(calls[at - 1]).toBe('translate(50.000,25.000)')
    expect(calls[at + 1]).toBe('translate(-50.000,-25.000)')
  })

  it('an upright object pays nothing', () => {
    const { ctx: c, calls } = ctx()
    drawObjects(c, args([rect(0)]))
    expect(calls.some(call => call.startsWith('rotate'))).toBe(false)
  })

  it('culling keeps a rotated object whose corner reaches into the view', () => {
    // A long thin bar just left of the view: upright it is off screen,
    // rotated 90° it pokes in.
    const bar = { ...rect(90), x: -160, y: 0, width: 300, height: 10 } as BoardObject
    const view = { minX: 0, minY: -50, maxX: 800, maxY: 600 }
    expect(
      isVisible({ ...bar, rotation: 0 } as BoardObject, { ...view, minX: 141 }),
    ).toBe(false)
    expect(isVisible(bar, view)).toBe(true)
  })
})
