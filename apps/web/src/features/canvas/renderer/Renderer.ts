import type { BoardObject, Viewport } from '@coboard/shared'
import { drawObjects } from './drawObjects.js'
import { drawInteraction } from './drawInteraction.js'
import { drawOverlay } from './drawOverlay.js'

/**
 * THE render loop. TRD §7.2.
 *
 * R-CANVAS-010 (Blocking): exactly ONE requestAnimationFrame loop exists in
 * this entire application. Not one per layer, not one per component.
 *
 * R-CANVAS-011 (Blocking): never draw synchronously from an event handler.
 * Handlers mutate state and call markDirty(). The loop draws.
 *
 * R-CANVAS-002 (Blocking) — the most important performance rule in the
 * project: a remote cursor moving must never cause layer 1 to redraw. The
 * dirty flags below are how that is guaranteed. drawObjects and drawOverlay
 * share no state and are triggered independently. See the layer-isolation test
 * in __tests__/Renderer.test.ts.
 */

export type Layer = 'objects' | 'interaction' | 'overlay'

export interface RenderSources {
  getViewport: () => Viewport
  /** Objects in z-order. The renderer never sorts — R-CONV-009. */
  getObjects: () => Iterable<BoardObject>
  getSize: () => { width: number; height: number }
}

export interface RenderTargets {
  objects: CanvasRenderingContext2D
  interaction: CanvasRenderingContext2D
  overlay: CanvasRenderingContext2D
}

export interface FrameMetrics {
  p50: number
  p95: number
  last: number
  count: number
  /** Frames the loop actually painted (at least one dirty layer). */
  painted: number
}

const METRICS_WINDOW = 120

export class Renderer {
  private dirty = { objects: true, interaction: true, overlay: true }
  private rafId = 0
  private running = false

  /** Ring buffer of frame durations. Pre-allocated — R-CANVAS-024. */
  private readonly frames = new Float64Array(METRICS_WINDOW)
  private frameIdx = 0
  private frameCount = 0
  private paintedCount = 0
  private lastFrameStart = 0

  /** Scratch array reused every frame so culling allocates nothing. */
  private readonly visible: BoardObject[] = []

  constructor(
    private readonly targets: RenderTargets,
    private readonly sources: RenderSources,
    private readonly dpr: () => number,
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.lastFrameStart = performance.now()
    this.rafId = requestAnimationFrame(this.tick)
  }

  /** R-CANVAS-014 (Blocking): a leaked loop is a leaked CPU core. */
  stop(): void {
    this.running = false
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
  }

  get isRunning(): boolean {
    return this.running
  }

  markDirty(layer: Layer): void {
    this.dirty[layer] = true
  }

  markAllDirty(): void {
    this.dirty.objects = true
    this.dirty.interaction = true
    this.dirty.overlay = true
  }

  /** Exposed for tests; the loop calls this itself. */
  renderOnce(): void {
    const { width, height } = this.sources.getSize()
    const viewport = this.sources.getViewport()
    const dpr = this.dpr()

    if (this.dirty.objects) {
      drawObjects(this.targets.objects, {
        viewport,
        width,
        height,
        dpr,
        objects: this.sources.getObjects(),
        scratch: this.visible,
      })
      this.dirty.objects = false
    }
    if (this.dirty.interaction) {
      drawInteraction(this.targets.interaction, { viewport, width, height, dpr })
      this.dirty.interaction = false
    }
    if (this.dirty.overlay) {
      drawOverlay(this.targets.overlay, { viewport, width, height, dpr })
      this.dirty.overlay = false
    }
  }

  private get anyDirty(): boolean {
    return this.dirty.objects || this.dirty.interaction || this.dirty.overlay
  }

  private tick = (): void => {
    const now = performance.now()
    const delta = now - this.lastFrameStart
    this.lastFrameStart = now

    // R-CANVAS-012: the loop runs continuously and does nothing when no layer
    // is dirty. Only frames that actually paint are timed — otherwise the
    // metrics would measure idle rAF cadence rather than render cost.
    const painting = this.anyDirty
    if (painting) {
      this.renderOnce()
      this.frames[this.frameIdx] = delta
      this.frameIdx = (this.frameIdx + 1) % METRICS_WINDOW
      if (this.frameCount < METRICS_WINDOW) this.frameCount++
      this.paintedCount++
    }

    if (this.running) this.rafId = requestAnimationFrame(this.tick)
  }

  getMetrics(): FrameMetrics {
    if (this.frameCount === 0) {
      return { p50: 0, p95: 0, last: 0, count: 0, painted: this.paintedCount }
    }
    const sample = Array.from(this.frames.subarray(0, this.frameCount)).sort((a, b) => a - b)
    const at = (q: number) => sample[Math.min(sample.length - 1, Math.floor(sample.length * q))]!
    const lastIdx = (this.frameIdx - 1 + METRICS_WINDOW) % METRICS_WINDOW
    return {
      p50: at(0.5),
      p95: at(0.95),
      last: this.frames[lastIdx]!,
      count: this.frameCount,
      painted: this.paintedCount,
    }
  }

  resetMetrics(): void {
    this.frames.fill(0)
    this.frameIdx = 0
    this.frameCount = 0
    this.paintedCount = 0
    this.lastFrameStart = performance.now()
  }
}
