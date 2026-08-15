import { useEffect } from 'react'
import { boardStore } from '../../../stores/boardStore.js'
import { beginPan, endPan, updatePan } from './handlers/pan.js'

/**
 * Pointer handling. FLOWS §15.1.
 *
 * Phase 2 wires the PANNING paths only — middle-mouse drag, and left-drag while
 * the Hand tool is active or Space is held. Drawing, selection and transforms
 * arrive in Phases 3 and 4.
 *
 * R-CANVAS-054: setPointerCapture on pointerdown. Without it, dragging outside
 * the window loses the interaction (anti-pattern A-21).
 *
 * R-CANVAS-052 (Blocking): pointercancel — fired when the OS steals the pointer
 * for a system gesture — is handled IDENTICALLY to a cancel. Ignoring it leaves
 * the app stuck in PANNING forever (anti-pattern A-20).
 */

const MIDDLE_BUTTON = 1

export function usePointer(element: HTMLElement | null, spaceHeld: () => boolean): void {
  useEffect(() => {
    if (!element) return

    const localPoint = (e: PointerEvent) => {
      const rect = element.getBoundingClientRect()
      return { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }

    const onPointerDown = (e: PointerEvent) => {
      const { activeTool } = boardStore.getState()
      const wantsPan = e.button === MIDDLE_BUTTON || activeTool === 'hand' || spaceHeld()
      if (!wantsPan) return

      const p = localPoint(e)
      if (!beginPan(e.pointerId, p.x, p.y)) return

      e.preventDefault()
      try {
        element.setPointerCapture(e.pointerId)
      } catch {
        // Capture can fail if the pointer is already gone. The pan still works;
        // it just won't track outside the element.
      }
    }

    const onPointerMove = (e: PointerEvent) => {
      if (boardStore.getState().interaction.type !== 'PANNING') return
      const p = localPoint(e)
      // R-CANVAS-011: mutate state only. The rAF loop draws.
      updatePan(p.x, p.y)
    }

    const finish = () => endPan(element)

    element.addEventListener('pointerdown', onPointerDown)
    element.addEventListener('pointermove', onPointerMove)
    element.addEventListener('pointerup', finish)
    // R-CANVAS-052: same treatment as pointerup, never ignored.
    element.addEventListener('pointercancel', finish)
    // Safety net: if the browser drops capture for any reason, exit cleanly
    // rather than stranding the machine in PANNING.
    element.addEventListener('lostpointercapture', finish)

    return () => {
      element.removeEventListener('pointerdown', onPointerDown)
      element.removeEventListener('pointermove', onPointerMove)
      element.removeEventListener('pointerup', finish)
      element.removeEventListener('pointercancel', finish)
      element.removeEventListener('lostpointercapture', finish)
      // R-CANVAS-053: release on unmount too — an error path counts.
      endPan(element)
    }
  }, [element, spaceHeld])
}
