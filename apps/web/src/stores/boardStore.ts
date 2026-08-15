import { create } from 'zustand'
import {
  COORD_MAX,
  COORD_MIN,
  ZOOM_MAX,
  ZOOM_MIN,
  clampZoom,
  screenPoint,
  unionRects,
  zoomAtPoint,
  type BoardObject,
  type ObjectId,
  type Viewport,
} from '@coboard/shared'
import type { InteractionState } from '../features/canvas/interaction/machine.js'

/**
 * The board store.
 *
 * R-ARCH-001/002/003 (Blocking): three layers, strict responsibilities.
 *   - React reads NARROW selectors only.
 *   - The renderer reads this store directly via `store.subscribe()`, OUTSIDE
 *     React, and never causes a re-render.
 *
 * R-ARCH-003: never subscribe a component to `objects`. That re-renders on
 * every mutation, 60 times a second, which is the single most common way this
 * project dies (anti-pattern A-01).
 *
 * R-STATE-001: objects live in a Map. O(n) lookups on 5,000 objects destroy the
 * frame budget.
 *
 * R-STATE-002: Zustand compares by reference, so mutating a Map in place does
 * NOT notify subscribers. The high-frequency path mutates in place and bumps
 * `objectsVersion`; the renderer watches that counter. Occasional writes may
 * construct a new Map instead.
 */

export type Tool = 'select' | 'hand' | 'pen' | 'eraser' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'sticky' | 'text' | 'image'

/** Tools implemented in Phase 2. The rest arrive with their phases. */
export const ACTIVE_TOOLS: readonly Tool[] = ['select', 'hand']

interface BoardState {
  // ─── Document state ───
  objects: Map<ObjectId, BoardObject>
  /** Bumped on any in-place object mutation — R-STATE-002. */
  objectsVersion: number
  /** Cached z-order. Invalidated on create/delete/z-change — R-CONV-009. */
  sortedIds: ObjectId[]

  // ─── Viewport ───
  viewport: Viewport

  // ─── Local UI state, never synced ───
  activeTool: Tool
  interaction: InteractionState

  // ─── Actions ───
  setViewport: (v: Viewport) => void
  panBy: (dxScreen: number, dyScreen: number) => void
  zoomAt: (screenX: number, screenY: number, factor: number) => void
  setZoom: (zoom: number, anchorX: number, anchorY: number) => void
  resetZoom: (anchorX: number, anchorY: number) => void
  zoomToFit: (viewWidth: number, viewHeight: number) => void
  setActiveTool: (t: Tool) => void
  setInteraction: (i: InteractionState) => void
  loadObjects: (objects: BoardObject[]) => void
}

const clampCoordValue = (n: number) => (n < COORD_MIN ? COORD_MIN : n > COORD_MAX ? COORD_MAX : n)

export const useBoardStore = create<BoardState>((set, get) => ({
  objects: new Map(),
  objectsVersion: 0,
  sortedIds: [],

  viewport: { x: 0, y: 0, zoom: 1 },

  activeTool: 'select',
  interaction: { type: 'IDLE' },

  setViewport: v => set({ viewport: { ...v, zoom: clampZoom(v.zoom) } }),

  /**
   * Pan by a SCREEN-space delta. R-COORD-007: mutates viewport.x/y only —
   * never object data, never hit-testing.
   */
  panBy: (dxScreen, dyScreen) =>
    set(s => ({ viewport: { ...s.viewport, x: s.viewport.x + dxScreen, y: s.viewport.y + dyScreen } })),

  /**
   * Pointer-anchored zoom — R-COORD-005 (Blocking), FR-CANVAS-003.
   * Delegates to the shared helper so the maths exists exactly once
   * (R-COORD-004). Centre-anchored zoom feels broken and is non-negotiable.
   */
  zoomAt: (screenX, screenY, factor) =>
    set(s => ({ viewport: zoomAtPoint(s.viewport, screenPoint(screenX, screenY), factor) })),

  setZoom: (zoom, anchorX, anchorY) =>
    set(s => {
      const target = clampZoom(zoom)
      return { viewport: zoomAtPoint(s.viewport, screenPoint(anchorX, anchorY), target / s.viewport.zoom) }
    }),

  resetZoom: (anchorX, anchorY) => get().setZoom(1, anchorX, anchorY),

  /**
   * Zoom to fit — FLOWS §8.2.4. Bounding box of all objects, 10% padding,
   * clamped to [0.1, 5]. With no objects, reset to (0, 0, zoom 1).
   */
  zoomToFit: (viewWidth, viewHeight) =>
    set(s => {
      const box = unionRects([...s.objects.values()])
      if (!box || box.width === 0 || box.height === 0) {
        return { viewport: { x: 0, y: 0, zoom: 1 } }
      }
      const pad = 1.1
      const zoom = clampZoom(
        Math.min(viewWidth / (box.width * pad), viewHeight / (box.height * pad)),
      )
      const cx = box.x + box.width / 2
      const cy = box.y + box.height / 2
      return {
        viewport: { x: viewWidth / 2 - cx * zoom, y: viewHeight / 2 - cy * zoom, zoom },
      }
    }),

  setActiveTool: t => set({ activeTool: t }),
  setInteraction: i => set({ interaction: i }),

  /**
   * Replace the object set. Used by the snapshot load (Phase 9) and, for now,
   * the dev stress fixture. Coordinates are clamped on the way in
   * (R-COORD-003, FLOWS E-04) — the renderer must never see an out-of-range
   * or non-finite value.
   */
  loadObjects: objects => {
    const map = new Map<ObjectId, BoardObject>()
    for (const o of objects) {
      map.set(o.id, { ...o, x: clampCoordValue(o.x), y: clampCoordValue(o.y) })
    }
    const sortedIds = [...map.values()]
      .sort((a, b) => (a.zIndex < b.zIndex ? -1 : a.zIndex > b.zIndex ? 1 : 0))
      .map(o => o.id)
    set(s => ({ objects: map, sortedIds, objectsVersion: s.objectsVersion + 1 }))
  },
}))

/** Non-React accessor for the renderer and interaction handlers. */
export const boardStore = useBoardStore

export { ZOOM_MAX, ZOOM_MIN }
