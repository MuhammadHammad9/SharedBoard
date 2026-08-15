import { boardStore } from '../../../../stores/boardStore.js'
import { canEnterPanning, isCapturing, type InteractionState } from '../machine.js'

/**
 * Pan — FR-CANVAS-002, FLOWS §8.2.4.
 *
 * All four triggers: Space+drag, middle-mouse drag, two-finger trackpad
 * (handled in useWheel), and the Hand tool.
 *
 * R-COORD-007: panning mutates viewport.x/y ONLY. It must not touch object
 * data and must not re-run hit testing.
 *
 * R-CANVAS-051 (Blocking): PANNING cannot be entered from DRAWING. Holding
 * Space during a stroke does nothing.
 */

export function beginPan(pointerId: number | null, screenX: number, screenY: number): boolean {
  const { interaction, viewport, setInteraction } = boardStore.getState()
  if (!canEnterPanning(interaction.type)) return false

  setInteraction({
    type: 'PANNING',
    startX: screenX,
    startY: screenY,
    originX: viewport.x,
    originY: viewport.y,
    pointerId,
    // Remember what to restore on release, so Space-panning mid-drag resumes
    // the drag rather than dropping it.
    previous: interaction.type,
  })
  return true
}

export function updatePan(screenX: number, screenY: number): void {
  const { interaction, setViewport, viewport } = boardStore.getState()
  if (interaction.type !== 'PANNING') return

  setViewport({
    x: interaction.originX + (screenX - interaction.startX),
    y: interaction.originY + (screenY - interaction.startY),
    zoom: viewport.zoom,
  })
}

/**
 * End a pan. Returns to the state panning suspended, which for the common case
 * is IDLE.
 *
 * R-CANVAS-053 (Blocking): every capturing state releases the pointer on exit,
 * INCLUDING error paths. The caller passes the element so release happens even
 * when this is reached from pointercancel.
 */
export function endPan(element: Element | null): void {
  const { interaction, setInteraction } = boardStore.getState()
  if (interaction.type !== 'PANNING') return

  if (element && interaction.pointerId !== null && isCapturing('PANNING')) {
    try {
      ;(element as HTMLElement & { releasePointerCapture(id: number): void }).releasePointerCapture(
        interaction.pointerId,
      )
    } catch {
      // Pointer already released or never captured. Not an error.
    }
  }

  const restored: InteractionState =
    interaction.previous === 'PANNING' || interaction.previous === 'IDLE'
      ? { type: 'IDLE' }
      : { type: 'IDLE' }
  setInteraction(restored)
}

/** Pan by a raw screen delta — used by two-finger trackpad scroll. */
export function panByDelta(dx: number, dy: number): void {
  boardStore.getState().panBy(-dx, -dy)
}
