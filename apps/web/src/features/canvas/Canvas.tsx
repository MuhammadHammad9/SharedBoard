import { useCallback, useEffect, useRef, useState } from 'react'
import { MAX_DPR, type BoardObject } from '@coboard/shared'
import { boardStore, useBoardStore } from '../../stores/boardStore.js'
import { Toolbar } from '../../components/board/Toolbar.js'
import { PropertiesPanel } from '../../components/board/PropertiesPanel.js'
import { ZoomControls } from '../../components/board/ZoomControls.js'
import {
  CanvasDebugOverlay,
  type DebugSnapshot,
} from '../../components/dev/CanvasDebugOverlay.js'
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
/**
 * Committed objects in z-order — R-CONV-009.
 *
 * A generator rather than a built array: the renderer calls this every painted
 * frame, and materialising 10,000 entries sixty times a second is the
 * allocation churn R-CANVAS-024 forbids. `sortedIds` may briefly name an id
 * the Map no longer holds during a delete, so misses are skipped rather than
 * asserted on.
 */
/** Shown by the debug overlay before the renderer has mounted. */
const EMPTY_METRICS = {
  p50: 0,
  p95: 0,
  last: 0,
  count: 0,
  painted: 0,
  inputP50: 0,
  inputP95: 0,
  inputCount: 0,
  objectPaints: 0,
  interactionPaints: 0,
} as const

function* objectsInZOrder(): Generator<BoardObject> {
  const { objects, sortedIds } = boardStore.getState()
  for (let i = 0; i < sortedIds.length; i++) {
    const o = objects.get(sortedIds[i]!)
    if (o) yield o
  }
}

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

  const getSize = useCallback(() => sizeRef.current, [])
  const getElement = useCallback(() => container, [container])

  /**
   * Input-to-pixel latency (PRD §7.1, ≤16 ms). Stable identity so it does not
   * churn the pointer listeners; the renderer it forwards to is swapped
   * through a ref rather than through the dependency array.
   */
  const noteInput = useCallback((timeStamp: number) => {
    rendererRef.current?.noteInput(timeStamp)
  }, [])

  const { spaceHeld } = useKeyboard({ getSize, getElement })
  usePointer(container, spaceHeld, { onInput: noteInput })
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
        // R-CONV-009: layer 1 paints in z-order. Iterating the Map's insertion
        // order was invisible while every object was a blockout tint; with
        // real overlapping strokes it is a visible painter's-algorithm bug.
        getObjects: objectsInZOrder,
        getSize: () => sizeRef.current,
        getDraft: () => boardStore.getState().draft,
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

    /*
     * R-ARCH-002: the renderer subscribes OUTSIDE React. Nothing below can
     * re-render a component.
     *
     * R-CANVAS-002 (Blocking) — the phase's real proof. A growing draft stroke
     * marks layer 2 and ONLY layer 2. Drawing must not repaint 10,000
     * committed objects sixty times a second, for exactly the reason a remote
     * cursor must not in Phase 10. The e2e test asserts the object-layer paint
     * count stays flat across a full drag.
     *
     * The viewport is the one input that dirties both: pan and zoom move the
     * committed objects and the in-flight stroke together.
     */
    const unsubscribe = boardStore.subscribe((state, prev) => {
      const viewportChanged = state.viewport !== prev.viewport
      if (viewportChanged || state.objectsVersion !== prev.objectsVersion) {
        renderer.markDirty('objects')
      }
      if (viewportChanged || state.draftVersion !== prev.draftVersion) {
        renderer.markDirty('interaction')
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

    /*
     * Test and dev hooks. Guarded so they never reach a production bundle —
     * a page that hands out its object graph on `window` is an invitation.
     *
     * `__coboardObjects` exists so the e2e suite can assert on what was
     * actually committed (point counts, colour, bounding box) without reading
     * pixels back off a canvas, which would be both slow and flaky.
     */
    if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
      const w = window as unknown as Record<string, unknown>
      w.__coboardMetrics = () => renderer.getMetrics()
      w.__coboardResetMetrics = () => renderer.resetMetrics()
      w.__coboardObjects = () => [...objectsInZOrder()]
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
    // The object count reaches the aria-label through the store selector, so
    // nothing here needs the resolved value.
    loadStressFixture().catch(err =>
      console.error('[canvas] stress fixture failed:', err),
    )
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
      metrics: rendererRef.current?.getMetrics() ?? EMPTY_METRICS,
    }
  }, [])

  // Narrow selectors only — R-ARCH-003. Never subscribe a component to
  // `objects`; that re-renders on every mutation, sixty times a second.
  const activeTool = useBoardStore(s => s.activeTool)
  const panning = useBoardStore(s => s.interaction.type === 'PANNING')
  const objectCount = useBoardStore(s => s.sortedIds.length)
  const cursor = panning
    ? 'grabbing'
    : activeTool === 'hand'
      ? 'grab'
      : activeTool === 'pen'
        ? 'crosshair'
        : 'default'

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
        aria-label={`Whiteboard with ${objectCount} objects`}
      >
        {/* Layer 0 (grid) is [P2] and intentionally absent. */}
        <canvas ref={objectsRef} id="objects" className="absolute inset-0" />
        <canvas ref={interactionRef} id="interaction" className="absolute inset-0" />
        <canvas ref={overlayRef} id="overlay" className="absolute inset-0" />
        <div id="text-overlay" className="pointer-events-none absolute inset-0" />
      </div>

      <Toolbar />
      <PropertiesPanel />
      <ZoomControls getSize={getSize} />
      {flags.debug && <CanvasDebugOverlay read={readDebug} />}
    </div>
  )
}
