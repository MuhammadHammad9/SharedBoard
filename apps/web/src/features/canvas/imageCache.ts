import { IMAGE_CACHE_CAP } from '@coboard/shared'

/**
 * Decoded images for the object layer — FR-CANVAS-010, R-PERF-023.
 *
 * LRU-capped at 100 (CLAUDE.md §11.2). A board can reference far more images
 * than are on screen, and every decoded bitmap holds width × height × 4 bytes;
 * an uncapped map is a heap that only grows.
 *
 * `crossOrigin = "anonymous"` on every load, decision D13-2. Without it the
 * first image drawn TAINTS the canvas, and export and thumbnails (both
 * `toBlob`) then throw a SecurityError. The bucket answers with CORS headers.
 *
 * The renderer never waits: `get` returns null while an image loads, the draw
 * path paints a neutral box, and `onChange` tells the canvas to redraw the
 * object layer when the bitmap is ready. A load is never a frame drop.
 */

export type ImageStatus = 'loading' | 'ready' | 'error'

interface Entry {
  image: HTMLImageElement
  status: ImageStatus
}

/** What the draw path needs — the cache, or a stand-in in tests. */
export interface ImageSource {
  get(url: string): HTMLImageElement | null
  status(url: string): ImageStatus | undefined
}

export class ImageCache implements ImageSource {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly cap = IMAGE_CACHE_CAP,
    private readonly createImage: () => HTMLImageElement = () => new Image(),
  ) {}

  /** The decoded image, or null while it loads (or if it failed). */
  get(url: string): HTMLImageElement | null {
    const entry = this.entries.get(url)
    if (entry) {
      // Most recently used goes to the back; eviction takes from the front.
      this.entries.delete(url)
      this.entries.set(url, entry)
      return entry.status === 'ready' ? entry.image : null
    }
    this.load(url)
    return null
  }

  status(url: string): ImageStatus | undefined {
    return this.entries.get(url)?.status
  }

  /** Called whenever an image finishes loading or fails. Returns unsubscribe. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Load ahead of drawing — export waits on this so its PNG is complete. */
  whenSettled(url: string): Promise<ImageStatus> {
    this.get(url)
    return new Promise(resolve => {
      const check = () => {
        const status = this.status(url)
        if (status === 'ready' || status === 'error' || status === undefined) {
          off()
          resolve(status ?? 'error')
        }
      }
      const off = this.onChange(check)
      check()
    })
  }

  get size(): number {
    return this.entries.size
  }

  private load(url: string): void {
    const image = this.createImage()
    const entry: Entry = { image, status: 'loading' }
    image.crossOrigin = 'anonymous'
    image.decoding = 'async'
    image.onload = () => {
      entry.status = 'ready'
      this.notify()
    }
    image.onerror = () => {
      entry.status = 'error'
      this.notify()
    }
    this.entries.set(url, entry)
    image.src = url

    while (this.entries.size > this.cap) {
      const oldest = this.entries.keys().next().value as string
      const evicted = this.entries.get(oldest)!
      // Drop the handlers so a late load of an evicted image is a no-op.
      evicted.image.onload = evicted.image.onerror = null
      this.entries.delete(oldest)
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

export const imageCache = new ImageCache()
