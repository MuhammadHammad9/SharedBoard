/**
 * FLOWS §14.5 — "Text editing scrolls the canvas so the edited object sits
 * above the keyboard."
 *
 * On a phone the on-screen keyboard shrinks the VISUAL viewport and leaves the
 * layout viewport alone, so a note placed in the lower half of the screen ends
 * up under the keyboard with its caret invisible. The fix is a pan of the
 * canvas — a viewport change, never a change to any stored coordinate
 * (R-COORD-002) — by exactly enough to bring the object's bottom edge above
 * the keyboard with a small margin.
 */

/** Space kept between the edited object and the top of the keyboard, px. */
export const KEYBOARD_MARGIN_PX = 16

/**
 * Vertical pan (screen px, positive = move the canvas down) that brings
 * `[objTop, objBottom]` inside `[visibleTop, visibleBottom]`. All values are
 * client (layout-viewport) pixels. Zero when it already fits.
 *
 * An object taller than the visible band is aligned by its TOP, where the
 * caret starts, rather than by its bottom.
 */
export function keyboardPanDelta(
  objTop: number,
  objBottom: number,
  visibleTop: number,
  visibleBottom: number,
  margin = KEYBOARD_MARGIN_PX,
): number {
  const top = visibleTop + margin
  const bottom = visibleBottom - margin
  if (objBottom - objTop > bottom - top) return top - objTop
  if (objBottom > bottom) return bottom - objBottom
  if (objTop < top) return top - objTop
  return 0
}

/** The visible band of the window, in client pixels, keyboard excluded. */
export function visibleBand(): { top: number; bottom: number } | null {
  if (typeof window === 'undefined') return null
  const vv = window.visualViewport
  if (!vv) return null
  return { top: vv.offsetTop, bottom: vv.offsetTop + vv.height }
}
