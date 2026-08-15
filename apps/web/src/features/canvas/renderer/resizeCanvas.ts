import { MAX_DPR } from '@coboard/shared'

/**
 * Size a canvas for the device pixel ratio. TRD §7.1.
 *
 * R-CANVAS-020: cap DPR at 2. 3x DPR quadruples the fill cost for no visible
 * gain and is ruinous on some phones (anti-pattern A-14).
 */
export function resizeCanvas(
  canvas: HTMLCanvasElement,
  cssW: number,
  cssH: number,
): number {
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
  canvas.width = Math.floor(cssW * dpr)
  canvas.height = Math.floor(cssH * dpr)
  canvas.style.width = `${cssW}px`
  canvas.style.height = `${cssH}px`
  const ctx = canvas.getContext('2d')
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return dpr
}

/** Pure form of the DPR sizing maths, for unit tests. */
export function backingStoreSize(
  cssW: number,
  cssH: number,
  devicePixelRatio: number,
): { width: number; height: number; dpr: number } {
  const dpr = Math.min(devicePixelRatio || 1, MAX_DPR)
  return { width: Math.floor(cssW * dpr), height: Math.floor(cssH * dpr), dpr }
}
