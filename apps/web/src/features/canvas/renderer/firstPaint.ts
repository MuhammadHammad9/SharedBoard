/**
 * Board first paint — PRD §7.1: ≤ 1.5 s at 500 objects, ≤ 3.0 s at 5,000.
 *
 * "First paint" is the first frame of layer 1 drawn AFTER the board's
 * document has loaded — not the first frame of the canvas, which paints an
 * empty grid long before the snapshot arrives and would make every board look
 * instant. The session arms the mark when the snapshot lands; the renderer
 * stamps it on its next objects-layer paint. A `performance.mark`, so on a
 * direct load its `startTime` is milliseconds since navigation start — the
 * measurement the PRD names — and any tool reading the Performance timeline
 * (the e2e suite, Lighthouse, DevTools) sees the same number.
 */
export const BOARD_FIRST_PAINT_MARK = 'coboard:board-first-paint'

let armed = false

/** The document has landed; the next layer-1 paint is the one to measure. */
export function armFirstPaint(): void {
  armed = true
}

/** Called by the renderer after each layer-1 paint. Marks once per load. */
export function markFirstPaintIfArmed(): void {
  if (!armed) return
  armed = false
  if (typeof performance?.mark === 'function') performance.mark(BOARD_FIRST_PAINT_MARK)
}
