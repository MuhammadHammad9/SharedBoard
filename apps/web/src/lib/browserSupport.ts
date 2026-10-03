/**
 * PRD §7.6 browser support.
 *
 * Internet Explorer never gets this far: it cannot run the module bundle, so
 * `index.html` carries a static copy of the message behind `<script nomodule>`.
 * This check catches the other case — a browser that runs modules but lacks an
 * API the canvas or the sync engine cannot work without. Better one honest
 * sentence than a board that half-renders and then throws on the first stroke.
 */
const REQUIRED: ReadonlyArray<[string, () => boolean]> = [
  ['PointerEvent', () => typeof window.PointerEvent === 'function'],
  ['ResizeObserver', () => typeof window.ResizeObserver === 'function'],
  ['WebSocket', () => typeof window.WebSocket === 'function'],
  ['crypto.randomUUID', () => typeof window.crypto?.randomUUID === 'function'],
  ['canvas 2D', () => typeof window.CanvasRenderingContext2D === 'function'],
]

/** The names of the missing APIs; empty when the browser is supported. */
export function missingBrowserFeatures(): string[] {
  return REQUIRED.filter(([, present]) => !present()).map(([name]) => name)
}
