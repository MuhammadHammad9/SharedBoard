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
  /** The frame this entry was last requested in — see `frame`. */
  usedInFrame: number
}

/** What the draw path needs — the cache, or a stand-in in tests. */
export interface ImageSource {
  get(url: string): HTMLImageElement | null
  status(url: string): ImageStatus | undefined
}

export class ImageCache implements ImageSource {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<() => void>()
  /**
   * A "frame" is one synchronous run of `get` calls: a layer-1 paint asks for
   * every visible image inside one rAF callback, and the counter advances on
   * the microtask after it. Entries requested in the current frame are never
   * evicted — with more than `cap` images on screen, evicting a visible one
   * would make it reload, re-dirty the layer and evict another visible one,
   * forever. The cache may exceed the cap for exactly as long as that many
   * images are visible, and is trimmed back on the next load after.
   */
  private frame = 0
  private frameScheduled = false

  constructor(
    private readonly cap = IMAGE_CACHE_CAP,
    private readonly createImage: () => HTMLImageElement = () => new Image(),
  ) {}

  /** The decoded image, or null while it loads (or if it failed). */
  get(url: string): HTMLImageElement | null {
    this.touchFrame()
    const entry = this.entries.get(url)
    if (entry) {
      entry.usedInFrame = this.frame
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
    const entry: Entry = { image, status: 'loading', usedInFrame: this.frame }
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

    this.trim()
  }

  /** Evict least-recently-used entries past the cap, sparing this frame's. */
  private trim(): void {
    let excess = this.entries.size - this.cap
    if (excess <= 0) return
    for (const [url, entry] of this.entries) {
      if (excess <= 0) break
      if (entry.usedInFrame === this.frame) continue
      // Drop the handlers so a late load of an evicted image is a no-op.
      entry.image.onload = entry.image.onerror = null
      this.entries.delete(url)
      excess -= 1
    }
  }

  private touchFrame(): void {
    if (this.frameScheduled) return
    this.frameScheduled = true
    queueMicrotask(() => {
      this.frameScheduled = false
      this.frame += 1
    })
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

export const imageCache = new ImageCache()
