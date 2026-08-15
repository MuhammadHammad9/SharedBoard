import { useCallback, useEffect, useRef, useState } from 'react'
import { MAX_DPR } from '@coboard/shared'
import { boardStore, useBoardStore } from '../../stores/boardStore.js'
import { ZoomControls } from '../../components/board/ZoomControls.js'
import { CanvasDebugOverlay, type DebugSnapshot } from '../../components/dev/CanvasDebugOverlay.js'
import { Renderer } from './renderer/Renderer.js'
import { resizeCanvas } from './renderer/resizeCanvas.js'
import { getViewRect, isVisible } from './geometry/culling.js'
import { useKeyboard } from './interaction/useKeyboard.js'
import { usePointer } from './interaction/usePointer.js'
import { useWheel } from './interaction/useWheel.js'
import { devFlags, loadStressFixture } from './devFixture.js'

/**
 * The canvas surface — FLOWS §14.3.
 *
 * Layer stack, bottom to top:
 *   0  <canvas id="grid">          [P2] — NOT BUILT. Slot reserved so z-order
 *                                   does not shift when the dot grid lands.
 *   1  <canvas id="objects">        committed objects
 *   2  <canvas id="interaction">    in-progress stroke, marquee, guides
 *   3  <canvas id="overlay">        selection, handles, remote cursors
 *   4  <div    id="text-overlay">   the DOM textarea for text editing
 *
 * R-CANVAS-002 (Blocking): a remote cursor moving must never redraw layer 1.
 * The layers are separate elements with independent dirty flags precisely so
 * that holds once Phase 10 starts drawing cursors at 20 Hz.
 *
 * R-SKILL-011 / R-MOTION-004: the canvas is a NO-DECORATION zone. No design
 * skill applies here. No entrance animation, no blur, no shadow, no gradient
 * on any layer. The only movement is the movement the user is making.
 *
 * R-ARCH-002: the Renderer is plain TypeScript. It reads the store directly
 * via subscribe() and never triggers a React render.
 */
export function Canvas() {
  /**
   * The container is held in STATE, not a ref.
   *
   * A ref is null during the render that mounts it, and mutating a ref does not
   * re-run effects — so passing `containerRef.current` into the input hooks
   * would hand them null forever and no pointer or wheel listener would ever
   * attach. A callback ref backed by state re-renders once on mount and the
   * hooks then receive the real element.
   */
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const objectsRef = useRef<HTMLCanvasElement>(null)
  const interactionRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)

  const rendererRef = useRef<Renderer | null>(null)
  const sizeRef = useRef({ width: 0, height: 0 })
  const dprRef = useRef(1)

  const [ready, setReady] = useState(false)
  const [flags] = useState(devFlags)
  const [fixtureCount, setFixtureCount] = useState<number | null>(null)

  const getSize = useCallback(() => sizeRef.current, [])

  const { spaceHeld } = useKeyboard({ getSize })
  usePointer(container, spaceHeld)
  useWheel(container)

  // ── Renderer lifecycle ────────────────────────────────────────────────────
  useEffect(() => {
    const objectsCanvas = objectsRef.current
    const interactionCanvas = interactionRef.current
    const overlayCanvas = overlayRef.current
    if (!objectsCanvas || !interactionCanvas || !overlayCanvas || !container) return

    const ctxObjects = objectsCanvas.getContext('2d')
    const ctxInteraction = interactionCanvas.getContext('2d')
    const ctxOverlay = overlayCanvas.getContext('2d')
    if (!ctxObjects || !ctxInteraction || !ctxOverlay) return

    const renderer = new Renderer(
      { objects: ctxObjects, interaction: ctxInteraction, overlay: ctxOverlay },
      {
        getViewport: () => boardStore.getState().viewport,
        getObjects: () => boardStore.getState().objects.values(),
        getSize: () => sizeRef.current,
      },
      () => dprRef.current,
    )
    rendererRef.current = renderer

    const applySize = () => {
      const rect = container.getBoundingClientRect()
      const width = Math.max(1, Math.floor(rect.width))
      const height = Math.max(1, Math.floor(rect.height))
      sizeRef.current = { width, height }
      dprRef.current = Math.min(window.devicePixelRatio || 1, MAX_DPR)
      resizeCanvas(objectsCanvas, width, height)
      resizeCanvas(interactionCanvas, width, height)
      resizeCanvas(overlayCanvas, width, height)
      // FLOWS E-10: a resize mid-drag must not drop the interaction. Only the
      // backing store changes; viewport and interaction state are untouched.
      renderer.markAllDirty()
    }

    applySize()
    const resizeObserver = new ResizeObserver(applySize)
    resizeObserver.observe(container)

    // R-ARCH-002: the renderer subscribes OUTSIDE React. A viewport or object
    // change marks layer 1 dirty; it never re-renders a component.
    const unsubscribe = boardStore.subscribe((state, prev) => {
      if (state.viewport !== prev.viewport || state.objectsVersion !== prev.objectsVersion) {
        renderer.markDirty('objects')
      }
    })

    // R-CANVAS-013: stop when hidden, restart when visible.
    const onVisibility = () => {
      if (document.hidden) renderer.stop()
      else {
        renderer.markAllDirty()
        renderer.start()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    renderer.start()
    setReady(true)

    if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
      ;(window as unknown as Record<string, unknown>).__coboardMetrics = () => renderer.getMetrics()
      ;(window as unknown as Record<string, unknown>).__coboardResetMetrics = () =>
        renderer.resetMetrics()
    }

    return () => {
      // R-CANVAS-014 / R-STATE-007: cancel the loop, drop every listener.
      renderer.stop()
      unsubscribe()
      resizeObserver.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      rendererRef.current = null
    }
  }, [container])

  // ── Dev stress fixture ────────────────────────────────────────────────────
  useEffect(() => {
    if (!flags.stress) return
    let cancelled = false
    loadStressFixture()
      .then(n => {
        if (!cancelled) setFixtureCount(n)
      })
      .catch(err => console.error('[canvas] stress fixture failed:', err))
    return () => {
      cancelled = true
    }
  }, [flags.stress])

  const readDebug = useCallback((): DebugSnapshot => {
    const { viewport, objects } = boardStore.getState()
    const { width, height } = sizeRef.current
    const view = getViewRect(viewport, width, height)
    let visible = 0
    for (const o of objects.values()) if (isVisible(o, view)) visible++
    return {
      viewport,
      totalObjects: objects.size,
      visibleObjects: visible,
      metrics: rendererRef.current?.getMetrics() ?? {
        p50: 0,
        p95: 0,
        last: 0,
        count: 0,
        painted: 0,
      },
    }
  }, [])

  const activeTool = useBoardStore(s => s.activeTool)
  const panning = useBoardStore(s => s.interaction.type === 'PANNING')
  const cursor = panning ? 'grabbing' : activeTool === 'hand' ? 'grab' : 'default'

  return (
    <div className="relative h-full w-full overflow-hidden bg-canvas">
      <div
        ref={setContainer}
        className="absolute inset-0 touch-none"
        style={{ cursor }}
        data-testid="canvas-surface"
        data-ready={ready ? 'true' : 'false'}
        // R-A11Y-008: the canvas is focusable so keyboard shortcuts have a home.
        tabIndex={0}
        // R-A11Y-006: text alternative. The count updates as objects change.
        role="img"
        aria-label={`Whiteboard with ${fixtureCount ?? 0} objects`}
      >
        {/* Layer 0 (grid) is [P2] and intentionally absent. */}
        <canvas ref={objectsRef} id="objects" className="absolute inset-0" />
        <canvas ref={interactionRef} id="interaction" className="absolute inset-0" />
        <canvas ref={overlayRef} id="overlay" className="absolute inset-0" />
        <div id="text-overlay" className="pointer-events-none absolute inset-0" />
      </div>

      <ZoomControls getSize={getSize} />
      {flags.debug && <CanvasDebugOverlay read={readDebug} />}
    </div>
  )
}
