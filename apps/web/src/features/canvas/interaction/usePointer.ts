import { useEffect } from 'react'
import { boardStore } from '../../../stores/boardStore.js'
import { beginPan, endPan, updatePan } from './handlers/pan.js'
import { appendPoint, beginDraw, cancelDraw, commitDraw } from './handlers/draw.js'

/**
 * Pointer handling. FLOWS §15.1.
 *
 * Phase 3 adds the DRAWING paths to Phase 2's PANNING ones. Selection and
 * transforms arrive in Phase 4.
 *
 * R-CANVAS-054: setPointerCapture on pointerdown. Without it, dragging outside
 * the window loses the interaction (anti-pattern A-21).
 *
 * R-CANVAS-052 (Blocking): pointercancel — fired when the OS steals the pointer
 * for a system gesture — is handled IDENTICALLY to a cancel. Ignoring it leaves
 * the app stuck mid-interaction forever (anti-pattern A-20).
 *
 * R-CANVAS-011 (Blocking): nothing here draws. Handlers mutate state and the
 * rAF loop paints, once per frame, however many events arrived.
 */

const MIDDLE_BUTTON = 1

/** Tools that draw on pointerdown. Grows as Phase 5 lands shapes. */
const DRAW_TOOLS = new Set(['pen'])

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

    const onPointerDown = (e: PointerEvent) => {
      const { activeTool } = boardStore.getState()

      // Pan outranks draw. Middle-mouse and Space are explicit "move the
      // paper" gestures and must work regardless of which tool is selected.
      const wantsPan = e.button === MIDDLE_BUTTON || activeTool === 'hand' || spaceHeld()
      if (wantsPan) {
        const p = localPoint(e)
        if (!beginPan(e.pointerId, p.x, p.y)) return
        e.preventDefault()
        capture(e.pointerId)
        return
      }

      // Primary button only — a right-click opens a context menu, it does not
      // start a stroke.
      if (e.button !== 0 || !DRAW_TOOLS.has(activeTool)) return

      const p = localPoint(e)
      if (!beginDraw(e.pointerId, p.x, p.y, e.pressure)) return
      e.preventDefault()
      capture(e.pointerId)
      onInput?.(e.timeStamp)
    }

    const onPointerMove = (e: PointerEvent) => {
      const { interaction } = boardStore.getState()

      if (interaction.type === 'PANNING') {
        const p = localPoint(e)
        updatePan(p.x, p.y)
        onInput?.(e.timeStamp)
        return
      }

      if (interaction.type !== 'DRAWING' || interaction.pointerId !== e.pointerId) return

      const rect = element.getBoundingClientRect()

      /*
       * Coalesced events — the reason a 240 Hz stylus does not draw a
       * 60-sample-per-second polygon.
       *
       * The browser delivers at most one pointermove per frame, but retains
       * every sample it received in between. Reading them back captures the
       * true path; ignoring them samples the user's hand at frame rate and
       * loses the fast parts of a stroke, which is exactly where curvature
       * lives. Simplification on commit throws the redundancy away again, so
       * the extra fidelity costs nothing downstream.
       */
      const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
      if (events.length > 0) {
        for (const ce of events) {
          appendPoint(ce.clientX - rect.left, ce.clientY - rect.top, ce.pressure)
        }
      } else {
        appendPoint(e.clientX - rect.left, e.clientY - rect.top, e.pressure)
      }
      onInput?.(e.timeStamp)
    }

    /** pointerup: pan ends, a stroke commits. */
    const onPointerUp = () => {
      const { interaction } = boardStore.getState()
      if (interaction.type === 'DRAWING') commitDraw(element)
      else endPan(element)
    }

    /** pointercancel / lostpointercapture: everything unwinds, nothing commits. */
    const onCancel = () => {
      const { interaction } = boardStore.getState()
      if (interaction.type === 'DRAWING') cancelDraw(element)
      else endPan(element)
    }

    element.addEventListener('pointerdown', onPointerDown)
    element.addEventListener('pointermove', onPointerMove)
    element.addEventListener('pointerup', onPointerUp)
    // R-CANVAS-052: same treatment as a cancel, never ignored.
    element.addEventListener('pointercancel', onCancel)
    // Safety net: if the browser drops capture for any reason, exit cleanly
    // rather than stranding the machine mid-interaction.
    element.addEventListener('lostpointercapture', onCancel)

    return () => {
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
