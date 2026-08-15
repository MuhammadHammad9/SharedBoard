import { useEffect } from 'react'
import { boardStore } from '../../../stores/boardStore.js'
import { panByDelta } from './handlers/pan.js'

/**
 * Wheel handling — pan and zoom. FLOWS §8.2.4.
 *
 * The `ctrlKey` discriminator is not a guess: a trackpad PINCH is delivered by
 * browsers as a wheel event with ctrlKey === true. There is no "pinch" event
 * and you will not find one. Two-finger scroll arrives with ctrlKey === false.
 *
 * Registered with { passive: false } because both paths call preventDefault —
 * otherwise the page zooms or scrolls underneath the canvas.
 */
export function useWheel(element: HTMLElement | null): void {
  useEffect(() => {
    if (!element) return

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()

      const rect = element.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top

      if (e.ctrlKey || e.metaKey) {
        // Zoom. Pointer-anchored via the store — R-COORD-005.
        // deltaY is negative when zooming in. The 0.002 factor makes a trackpad
        // pinch feel proportional without being twitchy.
        const factor = Math.exp(-e.deltaY * 0.002)
        boardStore.getState().zoomAt(x, y, factor)
      } else {
        // Two-finger scroll pans. R-COORD-007: viewport only.
        panByDelta(e.deltaX, e.deltaY)
      }
    }

    element.addEventListener('wheel', onWheel, { passive: false })
    // R-STATE-007: every listener has a matching remove.
    return () => element.removeEventListener('wheel', onWheel)
  }, [element])
}
