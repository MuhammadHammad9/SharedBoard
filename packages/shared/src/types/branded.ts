/**
 * Branded coordinate types.
 *
 * R-COORD-001 (Blocking): passing a ScreenPoint where a CanvasPoint is expected
 * must be a compile error, and vice versa.
 *
 * PRD risk R-7 rates coordinate-space confusion "Very High" likelihood. This
 * feels pedantic in week 1 and saves a full day in week 5.
 *
 * R-COORD-002 (Blocking): screen coordinates are NEVER stored. Object positions
 * are always canvas coordinates. If a stored coordinate changes when the user
 * pans, that is data corruption.
 */

/** The board's own infinite coordinate space. Objects are always stored in these. */
export type CanvasPoint = { readonly x: number; readonly y: number; readonly __brand: 'canvas' }

/** Pixel positions in the browser window. Derived, never persisted. */
export type ScreenPoint = { readonly x: number; readonly y: number; readonly __brand: 'screen' }

/** The visible rectangle: pan offset plus zoom scale. */
export interface Viewport {
  x: number
  y: number
  zoom: number
}

export const canvasPoint = (x: number, y: number): CanvasPoint =>
  ({ x, y }) as unknown as CanvasPoint

export const screenPoint = (x: number, y: number): ScreenPoint =>
  ({ x, y }) as unknown as ScreenPoint

/** Object identifier — uuid v4, generated client-side. */
export type ObjectId = string

/** Server-assigned, monotonic per board. The sole ordering authority (R-ARCH-008). */
export type Seq = number

/** One user's connection to one board. */
export type SessionId = string
