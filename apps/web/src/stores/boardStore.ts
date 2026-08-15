import { create } from 'zustand'
import {
  COORD_MAX,
  COORD_MIN,
  PEN_COLOURS,
  STROKE_WIDTH_MAX,
  STROKE_WIDTH_MIN,
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
import type { DraftStroke } from '../features/canvas/renderer/drawInteraction.js'
import { loadPrefs, savePrefs } from '../lib/persist.js'

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

/**
 * Tools with a working implementation. The rest render in the toolbar (FLOWS
 * §14.2 specifies all eleven) but are disabled and carry no keyboard shortcut:
 * a shortcut that selects a tool which draws nothing is worse than no
 * shortcut. Extended by each phase that lands a tool.
 */
export const ACTIVE_TOOLS: readonly Tool[] = ['select', 'hand', 'pen']

export const isActiveTool = (t: string): t is Tool => (ACTIVE_TOOLS as readonly string[]).includes(t)

/** Pen settings — FR-CANVAS-005, FLOWS §14.4. */
export interface PenSettings {
  color: string
  strokeWidth: number
  opacity: number
}

const DEFAULT_PEN: PenSettings = { color: PEN_COLOURS[0], strokeWidth: 3, opacity: 1 }

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
  pen: PenSettings
  interaction: InteractionState

  /**
   * The in-flight stroke. Points are pushed IN PLACE and `draftVersion` bumped
   * — R-STATE-002. Cloning a 400-element array on every pointermove at 240 Hz
   * is exactly the allocation churn R-CANVAS-024 exists to prevent.
   */
  draft: DraftStroke | null
  draftVersion: number

  // ─── Actions ───
  setViewport: (v: Viewport) => void
  panBy: (dxScreen: number, dyScreen: number) => void
  zoomAt: (screenX: number, screenY: number, factor: number) => void
  setZoom: (zoom: number, anchorX: number, anchorY: number) => void
  resetZoom: (anchorX: number, anchorY: number) => void
  zoomToFit: (viewWidth: number, viewHeight: number) => void
  setActiveTool: (t: Tool) => void
  setPen: (patch: Partial<PenSettings>) => void
  setInteraction: (i: InteractionState) => void
  loadObjects: (objects: BoardObject[]) => void
  addObject: (o: BoardObject) => void
  removeObject: (id: ObjectId) => void
  startDraft: (d: DraftStroke) => void
  touchDraft: () => void
  clearDraft: () => void
}

const clampCoordValue = (n: number) => (n < COORD_MIN ? COORD_MIN : n > COORD_MAX ? COORD_MAX : n)

/**
 * Preferences restored at module load, validated on the way in. See
 * lib/persist.ts — a stored value is untrusted input.
 */
const restored = loadPrefs(
  { activeTool: 'select', pen: DEFAULT_PEN },
  isActiveTool,
  { widthMin: STROKE_WIDTH_MIN, widthMax: STROKE_WIDTH_MAX },
)

export const useBoardStore = create<BoardState>((set, get) => ({
  objects: new Map(),
  objectsVersion: 0,
  sortedIds: [],

  viewport: { x: 0, y: 0, zoom: 1 },

  activeTool: restored.activeTool as Tool,
  pen: restored.pen,
  interaction: { type: 'IDLE' },

  draft: null,
  draftVersion: 0,

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

  setActiveTool: t => {
    set({ activeTool: t })
    savePrefs({ activeTool: t, pen: get().pen })
  },

  setPen: patch =>
    set(s => {
      const pen = { ...s.pen, ...patch }
      savePrefs({ activeTool: s.activeTool, pen })
      return { pen }
    }),

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

  /**
   * Insert one object.
   *
   * The Map is mutated in place and `objectsVersion` bumped rather than
   * cloned — a 10,000-entry Map copied per stroke is a visible hitch on
   * commit. `sortedIds` is a fresh array because React-side consumers may
   * hold it, and it is spliced at the correct z position rather than
   * re-sorted: an append-only board would otherwise pay O(n log n) on every
   * single stroke (R-CONV-009).
   */
  addObject: o =>
    set(s => {
      const clamped = { ...o, x: clampCoordValue(o.x), y: clampCoordValue(o.y) }
      s.objects.set(clamped.id, clamped)

      // Binary search for the insertion point by lexicographic zIndex.
      const ids = s.sortedIds
      let lo = 0
      let hi = ids.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        const z = s.objects.get(ids[mid]!)?.zIndex ?? ''
        if (z <= clamped.zIndex) lo = mid + 1
        else hi = mid
      }
      const sortedIds = ids.slice()
      sortedIds.splice(lo, 0, clamped.id)

      return { sortedIds, objectsVersion: s.objectsVersion + 1 }
    }),

  removeObject: id =>
    set(s => {
      if (!s.objects.delete(id)) return {}
      return {
        sortedIds: s.sortedIds.filter(x => x !== id),
        objectsVersion: s.objectsVersion + 1,
      }
    }),

  startDraft: d => set(s => ({ draft: d, draftVersion: s.draftVersion + 1 })),

  /**
   * Signal that the draft's point array grew. The array itself was mutated in
   * place by the caller; this only bumps the counter the renderer watches.
   */
  touchDraft: () => set(s => ({ draftVersion: s.draftVersion + 1 })),

  clearDraft: () => set(s => (s.draft === null ? {} : { draft: null, draftVersion: s.draftVersion + 1 })),
}))

/**
 * Fractional z-index key for a locally created object — TRD §6.4, D-8.
 *
 * A STRING ordered lexicographically, never an integer. Real key generation
 * BETWEEN two neighbours (so a remote insert can land mid-stack without
 * renumbering) arrives with the op log in Phase 9. Until then every local
 * object appends to the top, which is correct for the append-only case and
 * matches the fixture's `a` + fixed-width base-36 format so the two orderings
 * interleave correctly.
 */
export function nextZIndex(): string {
  const { objects, sortedIds } = useBoardStore.getState()
  const topId = sortedIds[sortedIds.length - 1]
  const top = topId ? objects.get(topId) : undefined
  const parsed = top ? Number.parseInt(top.zIndex.slice(1), 36) : NaN
  const next = Number.isFinite(parsed) ? parsed + 1 : sortedIds.length + 1
  return `a${next.toString(36).padStart(6, '0')}`
}

/** Non-React accessor for the renderer and interaction handlers. */
export const boardStore = useBoardStore

export { ZOOM_MAX, ZOOM_MIN }
