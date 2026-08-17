import { useEffect } from 'react'
import { boardStore } from '../../../stores/boardStore.js'
import { beginPan, endPan, updatePan } from './handlers/pan.js'
import { appendPoint, beginDraw, cancelDraw, commitDraw } from './handlers/draw.js'
import {
  beginMarquee,
  endMarquee,
  probe,
  selectObject,
  toCanvas,
  updateMarquee,
} from './handlers/select.js'
import {
  beginDrag,
  beginResize,
  beginRotate,
  cancelDrag,
  cancelResize,
  cancelRotate,
  endDrag,
  endResize,
  endRotate,
  updateDrag,
  updateResize,
  updateRotate,
} from './handlers/transform.js'
import { beginErase, endErase, eraseAt, updateEraseHover } from './handlers/erase.js'
import {
  beginCreate,
  cancelCreate,
  endCreate,
  isShapeTool,
  placeAndEdit,
  updateCreate,
} from './handlers/create.js'
import { commitTextEdit, editExisting } from './handlers/textEdit.js'

/**
 * Pointer handling. FLOWS §15.1.
 *
 * Phase 4 completes the machine: PANNING and DRAWING from Phases 2 and 3, plus
 * MARQUEEING, DRAGGING, RESIZING, ROTATING and ERASING.
 *
 * R-CANVAS-054: setPointerCapture on pointerdown for any drag or draw.
 * R-CANVAS-052 (Blocking): pointercancel is handled IDENTICALLY to a cancel.
 * R-CANVAS-053 (Blocking): every capturing state releases on exit, including
 *   error paths — which is why the effect cleanup routes through onCancel.
 * R-CANVAS-011 (Blocking): nothing here draws. Handlers mutate; the rAF loop
 *   paints, once per frame however many events arrived.
 */

const MIDDLE_BUTTON = 1

/** Tools that draw a freehand stroke on pointerdown. */
const DRAW_TOOLS = new Set(['pen'])

/**
 * Last pointer position in canvas coordinates, module-level.
 *
 * Mutated in place rather than stored in React or Zustand: it changes on every
 * pointermove and nothing renders from it (R-STATE-003). Only the paste
 * handler reads it, once per paste.
 */
const lastPointer = { x: 0, y: 0 }
export const getLastPointer = (): { x: number; y: number } => ({ ...lastPointer })

export interface PointerOptions {
  /** Renderer hook for input-to-pixel latency. Called with the event clock. */
  onInput?: (timeStamp: number) => void
}

export function usePointer(
  element: HTMLElement | null,
  spaceHeld: () => boolean,
  options: PointerOptions = {},
): void {
  const { onInput } = options

  useEffect(() => {
    if (!element) return

    const localPoint = (e: PointerEvent) => {
      const rect = element.getBoundingClientRect()
      return { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }

    const capture = (pointerId: number) => {
      try {
        element.setPointerCapture(pointerId)
      } catch {
        // Capture can fail if the pointer is already gone. The interaction
        // still works; it just won't track outside the element.
      }
    }

    /**
     * Route a Select-tool pointerdown. Order mirrors `probe`: handles, then
     * objects, then empty canvas.
     */
    const beginSelectGesture = (e: PointerEvent, cx: number, cy: number): boolean => {
      const coarse = e.pointerType !== 'mouse'
      const target = probe(cx, cy, coarse)

      if (target.kind === 'handle') {
        return target.handle === 'rotate'
          ? beginRotate(e.pointerId, cx, cy)
          : beginResize(e.pointerId, target.handle)
      }

      if (target.kind === 'object') {
        selectObject(target.id, e.shiftKey)
        // Shift+click is a selection EDIT, not the start of a drag — dragging
        // from it would move the group the user is still assembling.
        if (e.shiftKey) return false
        return beginDrag(e.pointerId, cx, cy)
      }

      // Empty canvas: marquee. beginMarquee also clears the selection, so a
      // press that never becomes a drag still deselects (FR-CANVAS-004).
      return beginMarquee(e.pointerId, cx, cy, e.shiftKey)
    }

    const onPointerDown = (e: PointerEvent) => {
      const { activeTool, editingTextId } = boardStore.getState()

      // A press anywhere on the canvas ends an open text edit first — the
      // overlay's own capture-phase handler usually gets there first, but a
      // press that lands inside the overlay's rect while it is already closing
      // must not start a gesture against a half-committed object.
      if (editingTextId) commitTextEdit()

      // Pan outranks everything. Middle-mouse and Space are explicit "move the
      // paper" gestures and must work regardless of which tool is selected.
      const wantsPan = e.button === MIDDLE_BUTTON || activeTool === 'hand' || spaceHeld()
      if (wantsPan) {
        const p = localPoint(e)
        if (!beginPan(e.pointerId, p.x, p.y)) return
        e.preventDefault()
        capture(e.pointerId)
        return
      }

      // Primary button only — a right-click opens a context menu.
      if (e.button !== 0) return

      const p = localPoint(e)
      const c = toCanvas(p.x, p.y)
      let started = false

      if (activeTool === 'eraser') {
        started = beginErase(e.pointerId, c.x, c.y)
      } else if (DRAW_TOOLS.has(activeTool)) {
        started = beginDraw(e.pointerId, p.x, p.y, e.pressure)
      } else if (isShapeTool(activeTool)) {
        started = beginCreate(e.pointerId, activeTool, c.x, c.y)
      } else if (activeTool === 'sticky' || activeTool === 'text') {
        // Click-placed and straight into edit mode — FR-CANVAS-008's "click
        // and type without a second action". No pointer capture: there is no
        // drag to track.
        placeAndEdit(activeTool, c.x, c.y)
        e.preventDefault()
        return
      } else if (activeTool === 'select') {
        started = beginSelectGesture(e, c.x, c.y)
      }

      if (!started) return
      e.preventDefault()
      capture(e.pointerId)
      onInput?.(e.timeStamp)
    }

    const onPointerMove = (e: PointerEvent) => {
      const { interaction, activeTool } = boardStore.getState()
      const p = localPoint(e)

      // Remember where the pointer is, in CANVAS space, so Cmd+V can paste
      // "at the pointer position" (FR-CANVAS-015) — a keyboard event has none
      // of its own.
      const here = toCanvas(p.x, p.y)
      lastPointer.x = here.x
      lastPointer.y = here.y

      switch (interaction.type) {
        case 'PANNING':
          updatePan(p.x, p.y)
          onInput?.(e.timeStamp)
          return

        case 'DRAWING': {
          if (interaction.pointerId !== e.pointerId) return
          const rect = element.getBoundingClientRect()
          /*
           * Coalesced events — the reason a 240 Hz stylus does not draw a
           * 60-sample-per-second polygon. The browser delivers at most one
           * pointermove per frame but retains every sample in between;
           * ignoring them loses the fast parts of a stroke, which is exactly
           * where curvature lives.
           */
          const events =
            typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
          if (events.length > 0) {
            for (const ce of events) {
              appendPoint(ce.clientX - rect.left, ce.clientY - rect.top, ce.pressure)
            }
          } else {
            appendPoint(p.x, p.y, e.pressure)
          }
          onInput?.(e.timeStamp)
          return
        }

        case 'MARQUEEING': {
          const c = toCanvas(p.x, p.y)
          updateMarquee(c.x, c.y)
          onInput?.(e.timeStamp)
          return
        }

        case 'DRAGGING': {
          const c = toCanvas(p.x, p.y)
          // FR-CANVAS-020: Ctrl temporarily disables snapping.
          updateDrag(c.x, c.y, !e.ctrlKey)
          onInput?.(e.timeStamp)
          return
        }

        case 'CREATING': {
          const c = toCanvas(p.x, p.y)
          updateCreate(c.x, c.y, e.shiftKey, e.altKey)
          onInput?.(e.timeStamp)
          return
        }

        case 'RESIZING': {
          const c = toCanvas(p.x, p.y)
          updateResize(c.x, c.y, { aspect: e.shiftKey, fromCentre: e.altKey })
          onInput?.(e.timeStamp)
          return
        }

        case 'ROTATING': {
          const c = toCanvas(p.x, p.y)
          updateRotate(c.x, c.y, e.shiftKey)
          onInput?.(e.timeStamp)
          return
        }

        case 'ERASING': {
          const c = toCanvas(p.x, p.y)
          eraseAt(c.x, c.y)
          onInput?.(e.timeStamp)
          return
        }

        default:
          // Idle hover. The eraser is the only tool with hover feedback
          // (R-MOTION-003) — it prevents an irreversible mistake.
          if (activeTool === 'eraser') {
            const c = toCanvas(p.x, p.y)
            updateEraseHover(c.x, c.y)
          }
      }
    }

    /** pointerup: each state commits its own way. */
    const onPointerUp = () => {
      switch (boardStore.getState().interaction.type) {
        case 'DRAWING':
          commitDraw(element)
          return
        case 'MARQUEEING':
          endMarquee(element)
          return
        case 'DRAGGING':
          endDrag(element)
          return
        case 'RESIZING':
          endResize(element)
          return
        case 'ROTATING':
          endRotate(element)
          return
        case 'ERASING':
          endErase(element)
          return
        case 'CREATING':
          endCreate(element)
          return
        default:
          endPan(element)
      }
    }

    /**
     * pointercancel / lostpointercapture — R-CANVAS-052.
     *
     * Transforms REVERT to their pointerdown state: the OS stole the pointer
     * mid-gesture, so the user never expressed an intent to commit. A stroke is
     * discarded for the same reason. An erase does NOT un-delete — those
     * objects are already gone, and resurrecting them here would fight Phase
     * 6's undo for ownership of that decision.
     */
    const onCancel = () => {
      switch (boardStore.getState().interaction.type) {
        case 'DRAWING':
          cancelDraw(element)
          return
        case 'MARQUEEING':
          endMarquee(element)
          return
        case 'DRAGGING':
          cancelDrag(element)
          return
        case 'RESIZING':
          cancelResize(element)
          return
        case 'ROTATING':
          cancelRotate(element)
          return
        case 'ERASING':
          endErase(element)
          return
        case 'CREATING':
          // A cancelled shape drag commits nothing: the user never released
          // the pointer, so they never said "this is the shape I want".
          cancelCreate(element)
          return
        default:
          endPan(element)
      }
    }

    /**
     * Double-click a sticky note or text object to edit it — FLOWS §15.1's
     * EDITING_TEXT entry.
     *
     * A single click selects; only a deliberate double-click opens the editor.
     * Otherwise every attempt to drag a note would drop the user into typing.
     */
    const onDoubleClick = (e: MouseEvent) => {
      if (boardStore.getState().activeTool !== 'select') return
      const rect = element.getBoundingClientRect()
      const c = toCanvas(e.clientX - rect.left, e.clientY - rect.top)
      const target = probe(c.x, c.y)
      if (target.kind === 'object') {
        e.preventDefault()
        editExisting(target.id)
      }
    }

    element.addEventListener('dblclick', onDoubleClick)
    element.addEventListener('pointerdown', onPointerDown)
    element.addEventListener('pointermove', onPointerMove)
    element.addEventListener('pointerup', onPointerUp)
    element.addEventListener('pointercancel', onCancel)
    // Safety net: if the browser drops capture for any reason, exit cleanly
    // rather than stranding the machine mid-interaction.
    element.addEventListener('lostpointercapture', onCancel)

    return () => {
      element.removeEventListener('dblclick', onDoubleClick)
      element.removeEventListener('pointerdown', onPointerDown)
      element.removeEventListener('pointermove', onPointerMove)
      element.removeEventListener('pointerup', onPointerUp)
      element.removeEventListener('pointercancel', onCancel)
      element.removeEventListener('lostpointercapture', onCancel)
      // R-CANVAS-053: release on unmount too — an error path counts.
      onCancel()
    }
  }, [element, spaceHeld, onInput])
}
