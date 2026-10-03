import { describe, expect, it, vi } from 'vitest'
import type { ImageObject } from '@coboard/shared'
import { ImageCache } from '../imageCache.js'
import { drawImageObject } from '../renderer/shapes/image.js'

/** FR-CANVAS-010, R-PERF-023 — the LRU image cache and the image draw path. */

interface FakeImage {
  src: string
  crossOrigin: string | null
  decoding: string
  onload: (() => void) | null
  onerror: (() => void) | null
}

function harness(cap = 3) {
  const made: FakeImage[] = []
  const cache = new ImageCache(cap, () => {
    const image: FakeImage = {
      src: '',
      crossOrigin: null,
      decoding: '',
      onload: null,
      onerror: null,
    }
    made.push(image)
    return image as unknown as HTMLImageElement
  })
  return { cache, made }
}

describe('ImageCache', () => {
  it('returns null while loading, the bitmap once loaded, and asks for CORS', () => {
    const { cache, made } = harness()
    const changed = vi.fn()
    cache.onChange(changed)

    expect(cache.get('a.png')).toBeNull()
    expect(made[0]!.crossOrigin).toBe('anonymous')
    expect(cache.status('a.png')).toBe('loading')

    made[0]!.onload!()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(cache.get('a.png')).toBe(made[0])
    // A second get does not load again.
    expect(made).toHaveLength(1)
  })

  it('evicts the least recently USED entry past the cap, not the oldest loaded', () => {
    const { cache } = harness(3)
    cache.get('a')
    cache.get('b')
    cache.get('c')
    cache.get('a') // touch: b is now the least recently used
    cache.get('d')
    expect(cache.size).toBe(3)
    expect(cache.status('b')).toBeUndefined()
    expect(cache.status('a')).toBe('loading')
  })

  it('a late load of an evicted image is a no-op', () => {
    const { cache, made } = harness(1)
    const changed = vi.fn()
    cache.onChange(changed)
    cache.get('a')
    cache.get('b') // evicts a
    expect(made[0]!.onload).toBeNull()
    expect(changed).not.toHaveBeenCalled()
  })

  it('records a failure, and whenSettled resolves for it', async () => {
    const { cache, made } = harness()
    const settled = cache.whenSettled('broken.png')
    made[0]!.onerror!()
    expect(await settled).toBe('error')
    expect(cache.get('broken.png')).toBeNull()
  })
})

describe('drawImageObject', () => {
  const object = {
    type: 'image',
    url: 'https://cdn/x.png',
    x: 10,
    y: 20,
    width: 300,
    height: 200,
    opacity: 1,
    cornerRadius: 0,
  } as ImageObject

  function ctx() {
    const calls: string[] = []
    const record =
      (name: string) =>
      (...args: unknown[]) =>
        calls.push(`${name}(${args.filter(a => typeof a === 'number').join(',')})`)
    return {
      calls,
      ctx: {
        save: record('save'),
        restore: record('restore'),
        beginPath: record('beginPath'),
        roundRect: record('roundRect'),
        clip: record('clip'),
        drawImage: record('drawImage'),
        fillRect: record('fillRect'),
        set globalAlpha(_v: number) {},
        set fillStyle(_v: string) {},
      } as unknown as CanvasRenderingContext2D,
    }
  }

  it('fills the box while the bitmap is not ready — the layout never jumps', () => {
    const { ctx: c, calls } = ctx()
    drawImageObject(c, object, { get: () => null, status: () => 'loading' })
    expect(calls).toContain('fillRect(10,20,300,200)')
    expect(calls.some(call => call.startsWith('drawImage'))).toBe(false)
  })

  it('draws the bitmap into the object box, clipped when the corners are round', () => {
    const { ctx: c, calls } = ctx()
    const bitmap = {} as HTMLImageElement
    drawImageObject(
      c,
      { ...object, cornerRadius: 12 },
      { get: () => bitmap, status: () => 'ready' },
    )
    expect(calls).toContain('roundRect(10,20,300,200,12)')
    expect(calls).toContain('drawImage(10,20,300,200)')
  })
})
