import { describe, expect, it, vi } from 'vitest'
import type { BoardObject } from '@coboard/shared'
import { renderThumbnail } from '../thumbnail.js'

/** FR-BOARD-003 — 640×400 JPEG at 0.7, the content framed with 5% padding. */

const rect = (x: number, y: number, width: number, height: number) =>
  ({
    id: `${x}`,
    type: 'rect',
    x,
    y,
    width,
    height,
    rotation: 0,
    stroke: '#18181B',
    strokeWidth: 2,
    fill: 'none',
    opacity: 1,
  }) as unknown as BoardObject

function fakeCanvas() {
  const transforms: number[][] = []
  const ctx = new Proxy(
    {
      translate: (x: number, y: number) => transforms.push(['t', x, y] as never),
      scale: (x: number) => transforms.push(['s', x] as never),
    } as Record<string, unknown>,
    { get: (target, key) => target[key as string] ?? vi.fn() },
  )
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx,
    toDataURL: vi.fn(() => `data:image/jpeg;base64,${btoa('\xff\xd8\xff')}`),
  }
  return {
    canvas: canvas as unknown as HTMLCanvasElement,
    transforms,
    toDataURL: canvas.toDataURL,
  }
}

const images = { get: () => null, status: () => undefined }

describe('renderThumbnail', () => {
  it('an empty board has no thumbnail — the placeholder graphic shows instead', () => {
    expect(renderThumbnail([], images, () => fakeCanvas().canvas)).toBeNull()
  })

  it('is a 640×400 JPEG at quality 0.7', () => {
    const fake = fakeCanvas()
    const blob = renderThumbnail([rect(0, 0, 100, 100)], images, () => fake.canvas)
    expect(fake.canvas.width).toBe(640)
    expect(fake.canvas.height).toBe(400)
    expect(fake.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.7)
    expect(blob?.type).toBe('image/jpeg')
  })

  it('frames the content with 5% padding, centred', () => {
    const fake = fakeCanvas()
    // 1000 × 500 of content; 5% of the longer side is 50 on every edge →
    // 1100 × 600 framed, fitted into 640 × 400 by width: zoom 640/1100.
    renderThumbnail([rect(0, 0, 1000, 500)], images, () => fake.canvas)
    const zoom = 640 / 1100
    const scale = fake.transforms.find(t => t[0] === ('s' as never))!
    expect(scale[1]).toBeCloseTo(zoom, 6)
    const translate = fake.transforms.find(t => t[0] === ('t' as never))!
    expect(translate[1]).toBeCloseTo(50 * zoom, 6)
    // Vertically centred in the 400 px band.
    expect(translate[2]).toBeCloseTo((400 - 600 * zoom) / 2 + 50 * zoom, 6)
  })
})
