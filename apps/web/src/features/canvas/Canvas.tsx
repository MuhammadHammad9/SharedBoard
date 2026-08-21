import { useCallback, useEffect, useRef, useState } from 'react'
import { MAX_DPR, type ObjectId } from '@coboard/shared'
import { boardStore, objectsInZOrder, useBoardStore } from '../../stores/boardStore.js'
import { Toolbar } from '../../components/board/Toolbar.js'
import { PropertiesPanel } from '../../components/board/PropertiesPanel.js'
import { ZoomControls } from '../../components/board/ZoomControls.js'
import { UndoRedoControls } from '../../components/board/UndoRedoControls.js'
import { history } from './history/history.js'
import {
  CanvasDebugOverlay,
  type DebugSnapshot,
} from '../../components/dev/CanvasDebugOverlay.js'
import { Renderer, type SelectionView } from './renderer/Renderer.js'
import {
  currentSelectionBox,
  marqueeRect,
  probe,
  toCanvas,
} from './interaction/handlers/select.js'
import { HANDLE_CURSORS } from './geometry/bounds.js'
import { buildObject } from './interaction/handlers/create.js'
import { setViewSizeSource } from './interaction/handlers/transform.js'
import { TextOverlay } from './TextOverlay.js'
import { ContextMenu } from '../../components/board/ContextMenu.js'
import { resizeCanvas } from './renderer/resizeCanvas.js'
import { getViewRect, isVisible } from './geometry/culling.js'
import { useKeyboard } from './interaction/useKeyboard.js'
import { getLastPointer, usePointer } from './interaction/usePointer.js'
import { useWheel } from './interaction/useWheel.js'
import { devFlags, loadStressFixture } from './devFixture.js'
import { buildPresenceView } from '../presence/usePresence.js'
import { emitSelection } from '../presence/bus.js'
import { presenceStore } from '../presence/presenceStore.js'

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
  overlayPaints: 0,
} as const

/**
 * Everything layers 2 and 3 need about the selection, read fresh each frame.
 *
 * Lives outside the component and reads the store directly (R-ARCH-002): the
 * renderer must never depend on React having re-rendered, and the selection
 * box changes on every pointermove of a drag — sixty React renders a second is
 * exactly the failure R-ARCH-003 exists to prevent.
 */
function readSelectionView(): SelectionView {
  const { interaction, eraseCandidate } = boardStore.getState()

  return {
    box: currentSelectionBox(),
    // Handles are hidden during a live transform. Eight little squares
    // skittering around under the cursor while the user drags is noise, and
    // they are unclickable during the gesture anyway.
    showHandles: interaction.type === 'IDLE' || interaction.type === 'PANNING',
    marquee: interaction.type === 'MARQUEEING' ? marqueeRect(interaction) : null,
    rotationDeg: interaction.type === 'ROTATING' ? interaction.currentDeg : null,
    eraseCandidate,
    // The in-progress shape is built through the same factory the commit uses,
    // so the preview and the result cannot diverge.
    creating:
      interaction.type === 'CREATING'
        ? buildObject(interaction.tool, interaction.box, PREVIEW_ID)
        : null,
    guides: interaction.type === 'DRAGGING' ? interaction.guides : [],
  }
}

/** A fixed id for the un-committed preview object. It never reaches the store. */
const PREVIEW_ID = '00000000-0000-4000-8000-000000000000' as ObjectId

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

  const { spaceHeld } = useKeyboard({ getSize, getElement, getPointer: getLastPointer })
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
        getSelectionView: readSelectionView,
        getPresenceView: buildPresenceView,
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
    // The alignment-guide search culls to the visible set and needs the
    // viewport's pixel size; hand it the same source the renderer uses.
    setViewSizeSource(() => sizeRef.current)
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
      const interactionChanged = state.interaction !== prev.interaction

      // Layer 1 — committed objects. The eraser highlight lives here because
      // it recolours a real object rather than drawing on top of it.
      if (
        viewportChanged ||
        state.objectsVersion !== prev.objectsVersion ||
        state.eraseCandidate !== prev.eraseCandidate
      ) {
        renderer.markDirty('objects')
      }

      // Layer 2 — draft stroke and marquee. `interactionChanged` is what
      // drives the marquee: it lives entirely in the interaction state, so
      // there is no separate version counter to watch.
      if (
        viewportChanged ||
        state.draftVersion !== prev.draftVersion ||
        interactionChanged
      ) {
        renderer.markDirty('interaction')
      }

      /*
       * Layer 3 — the selection overlay. Deliberately NOT dirtied by
       * `objectsVersion` alone: that fires on every pointermove of a drag, and
       * the box does need to follow. It is dirtied by `interactionChanged`
       * instead, which covers the transform states, plus the selection itself
       * and the viewport. During a drag the interaction object is replaced
       * only once (on the `moved` flag), so the box is refreshed by the
       * objectsVersion clause below — kept explicit so the coupling is visible
       * rather than accidental.
       */
      if (
        viewportChanged ||
        interactionChanged ||
        state.selection !== prev.selection ||
        state.objectsVersion !== prev.objectsVersion
      ) {
        renderer.markDirty('overlay')
      }

      /*
       * Broadcast the selection as presence — FR-RT-005.
       *
       * Driven from the store subscription rather than from each of the six
       * mutators that can change a selection, so there is one emit point
       * instead of six that must each remember. The emitter throttles.
       */
      if (state.selection !== prev.selection) emitSelection(state.selection)
    })

    /*
     * Presence dirties layer 3 AND ONLY LAYER 3 — R-CANVAS-002.
     *
     * A cursor arriving at 20 Hz from each of ten people is 200 marks a
     * second. Every one of them lands here, on the overlay, and there is no
     * path from this subscription to `markDirty('objects')`. That is the whole
     * bargain of the four-layer split, and `presence.spec.ts` asserts it by
     * reading the object layer's paint counter across a cursor sweep.
     *
     * A fixed 30 Hz tick rather than a mark per message: the interpolation
     * needs a frame even when no new sample has arrived (it is filling the gap
     * BETWEEN samples), and marking per message would repaint 200 times a
     * second to show 60 frames.
     */
    const presenceTick = window.setInterval(() => {
      if (buildPresenceView()) renderer.markDirty('overlay')
    }, 33)

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
      /*
       * Presence, for the e2e suite. Exposed so `presence.spec.ts` can inject
       * a remote cursor without a second browser and assert — the point of
       * the whole phase — that the object layer's paint counter does not move
       * while it travels (R-CANVAS-002).
       */
      w.__coboardPresence = presenceStore
      w.__coboardResetMetrics = () => renderer.resetMetrics()
      w.__coboardObjects = () => [...objectsInZOrder()]
      w.__coboardSelection = () => [...boardStore.getState().selection]
      w.__coboardSelect = (ids: string[]) =>
        boardStore.getState().setSelection(ids as ObjectId[])
      // Store-commit counter. The E-07 batching test reads this to prove a
      // 500-object drag is one write per frame, not five hundred.
      w.__coboardVersion = () => boardStore.getState().objectsVersion
      /*
       * The LIVE viewport. Tests that need to convert canvas → screen must
       * read it here and not from the ?debug=1 overlay: that overlay repaints
       * on a 250 ms interval by design, so reading it right after a zoom gives
       * a stale pan and a click target tens of pixels off.
       */
      w.__coboardViewport = () => ({ ...boardStore.getState().viewport })
      // Stack depths, so the AT-42..AT-44 e2e specs can assert on grouping —
      // "ten actions produced ten entries" is not visible from the board.
      w.__coboardHistory = () => ({
        undo: history.undoDepth(),
        redo: history.redoDepth(),
      })
    }

    return () => {
      // R-CANVAS-014 / R-STATE-007: cancel the loop, drop every listener.
      renderer.stop()
      unsubscribe()
      // R-UNDO-006: history does not outlive the board. Keeping a stack whose
      // entries name objects on a board the user has left is worse than
      // keeping none — the first Ctrl+Z on the next board would be a silent
      // run of ten stale skips.
      history.clear()
      resizeObserver.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      window.clearInterval(presenceTick)
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
  const interactionType = useBoardStore(s => s.interaction.type)
  const objectCount = useBoardStore(s => s.sortedIds.length)

  /*
   * ONE effect owns the cursor, and it is deliberately not a React style prop.
   *
   * While the Select tool is idle the cursor depends on what is under the
   * pointer — a handle, an object, or empty canvas — which changes on every
   * pointermove. That is explicitly not React state (R-STATE-003), so it is
   * written straight to the element.
   *
   * Splitting it across a `style` prop and an effect does not work: effect
   * cleanup runs AFTER React commits the new style, so the cleanup wipes the
   * value React just set and the cursor falls back to `auto`. One owner, no
   * race.
   */
  useEffect(() => {
    if (!container) return

    const base =
      interactionType === 'PANNING' || interactionType === 'ROTATING'
        ? 'grabbing'
        : interactionType === 'DRAGGING'
          ? 'move'
          : activeTool === 'hand'
            ? 'grab'
            : activeTool === 'pen' || activeTool === 'eraser'
              ? 'crosshair'
              : 'default'

    container.style.cursor = base

    // Hover feedback applies only when the Select tool is at rest. During a
    // gesture the cursor must stay fixed to whatever that gesture means.
    if (activeTool !== 'select' || interactionType !== 'IDLE') return

    // FLOWS §14.2: a distinct resize cursor per handle, so the affordance
    // tells the user which axis they are about to change.
    const onMove = (e: PointerEvent) => {
      const rect = container.getBoundingClientRect()
      const c = toCanvas(e.clientX - rect.left, e.clientY - rect.top)
      const target = probe(c.x, c.y, e.pointerType !== 'mouse')
      container.style.cursor =
        target.kind === 'handle'
          ? HANDLE_CURSORS[target.handle]
          : target.kind === 'object'
            ? 'move'
            : 'default'
    }

    container.addEventListener('pointermove', onMove)
    return () => container.removeEventListener('pointermove', onMove)
  }, [container, activeTool, interactionType])

  return (
    <div className="relative h-full w-full overflow-hidden bg-canvas">
      <div
        ref={setContainer}
        className="absolute inset-0 touch-none"
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

      <TextOverlay container={container} />
      <Toolbar />
      <PropertiesPanel />
      <ContextMenu container={container} getSize={getSize} />
      <ZoomControls getSize={getSize} />
      <UndoRedoControls />
      {flags.debug && <CanvasDebugOverlay read={readDebug} />}
    </div>
  )
}
