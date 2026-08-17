import { create } from 'zustand'
import {
  COORD_MAX,
  COORD_MIN,
  PEN_COLOURS,
  STICKY_COLOURS,
  STROKE_WIDTH_MAX,
  STROKE_WIDTH_MIN,
  ZOOM_MAX,
  ZOOM_MIN,
  clampZoom,
  screenPoint,
  unionRects,
  zoomAtPoint,
  type BoardObject,
  type ClientOp,
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

export type Tool =
  | 'select'
  | 'hand'
  | 'pen'
  | 'eraser'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'sticky'
  | 'text'
  | 'image'

/**
 * Tools with a working implementation. The rest render in the toolbar (FLOWS
 * §14.2 specifies all eleven) but are disabled and carry no keyboard shortcut:
 * a shortcut that selects a tool which draws nothing is worse than no
 * shortcut. Extended by each phase that lands a tool.
 */
export const ACTIVE_TOOLS: readonly Tool[] = [
  'select',
  'hand',
  'pen',
  'eraser',
  'rect',
  'ellipse',
  'line',
  'arrow',
  'sticky',
  'text',
]

export const isActiveTool = (t: string): t is Tool =>
  (ACTIVE_TOOLS as readonly string[]).includes(t)

/** Pen settings — FR-CANVAS-005, FLOWS §14.4. */
export interface PenSettings {
  color: string
  strokeWidth: number
  opacity: number
}

const DEFAULT_PEN: PenSettings = { color: PEN_COLOURS[0], strokeWidth: 3, opacity: 1 }

/** Shape settings — FR-CANVAS-007, FLOWS §14.4. */
export interface ShapeSettings {
  stroke: string
  strokeWidth: number
  fill: string
  cornerRadius: number
  opacity: number
}

const DEFAULT_SHAPE: ShapeSettings = {
  stroke: PEN_COLOURS[0],
  strokeWidth: 2,
  fill: 'none',
  cornerRadius: 0,
  opacity: 1,
}

/** Sticky settings — FR-CANVAS-008. Colour is one of the 8 frozen values. */
export interface StickySettings {
  color: string
}

const DEFAULT_STICKY: StickySettings = { color: STICKY_COLOURS.yellow }

/** Text settings — FR-CANVAS-009. */
export interface TextSettings {
  color: string
  fontSize: number
  bold: boolean
  italic: boolean
  textAlign: 'left' | 'center' | 'right'
}

const DEFAULT_TEXT: TextSettings = {
  color: PEN_COLOURS[0],
  fontSize: 16,
  bold: false,
  italic: false,
  textAlign: 'left',
}

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
  shape: ShapeSettings
  sticky: StickySettings
  text: TextSettings
  interaction: InteractionState

  /**
   * Selected object ids — FR-CANVAS-004.
   *
   * R-STATE-004 permits React to read the selection COUNT and a derived
   * summary. Components must not map over this to read object geometry; the
   * properties panel selects a derived summary instead (R-ARCH-003).
   */
  selection: ObjectId[]

  /**
   * Object under the eraser, highlighted in --color-danger — FR-CANVAS-006.
   * A separate field from `selection` because it is a hover affordance, not a
   * selection, and it must not survive a tool change.
   */
  eraseCandidate: ObjectId | null

  /**
   * The object the DOM text overlay is editing — TRD §9.1, FLOWS §15.1.
   *
   * `justCreated` drives the empty-discard rule (FLOWS §8.2.2 step 4): an
   * empty note is deleted on blur only if it was created in THIS interaction.
   * Clearing an existing note's text and clicking away is a deliberate edit,
   * not an accident, and must not silently destroy the object.
   */
  editingTextId: ObjectId | null
  editingJustCreated: boolean

  /**
   * In-memory clipboard — FR-CANVAS-015.
   *
   * The system clipboard is the primary channel (it is what makes cross-tab
   * paste work), but reading it can be denied by permission policy. This is
   * the fallback so copy/paste never simply stops working inside one tab.
   */
  clipboard: BoardObject[]

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
  setShape: (patch: Partial<ShapeSettings>) => void
  setSticky: (patch: Partial<StickySettings>) => void
  setText: (patch: Partial<TextSettings>) => void
  beginTextEdit: (id: ObjectId, justCreated: boolean) => void
  endTextEdit: () => void
  setClipboard: (objects: BoardObject[]) => void
  setInteraction: (i: InteractionState) => void
  loadObjects: (objects: BoardObject[]) => void
  addObject: (o: BoardObject) => void
  removeObject: (id: ObjectId) => void
  /** Replace many objects in one commit — E-07. */
  updateObjects: (objects: readonly BoardObject[]) => void
  /** Delete many objects in one commit — FR-CANVAS-014. */
  deleteObjects: (ids: readonly ObjectId[]) => void
  /**
   * Apply a batch of ops to the document — the ONLY write path that undo,
   * redo and (from Phase 9) remote ops share. See features/canvas/history.
   */
  applyOps: (ops: readonly ClientOp[]) => void
  setSelection: (ids: readonly ObjectId[]) => void
  /** Recompute the cached z-order after zIndex values change — R-CONV-009. */
  reorder: () => void
  toggleSelection: (id: ObjectId) => void
  clearSelection: () => void
  selectAll: () => void
  setEraseCandidate: (id: ObjectId | null) => void
  startDraft: (d: DraftStroke) => void
  touchDraft: () => void
  clearDraft: () => void
}

const clampCoordValue = (n: number) =>
  n < COORD_MIN ? COORD_MIN : n > COORD_MAX ? COORD_MAX : n

/**
 * Preferences restored at module load, validated on the way in. See
 * lib/persist.ts — a stored value is untrusted input.
 */
const restored = loadPrefs({ activeTool: 'select', pen: DEFAULT_PEN }, isActiveTool, {
  widthMin: STROKE_WIDTH_MIN,
  widthMax: STROKE_WIDTH_MAX,
})

export const useBoardStore = create<BoardState>((set, get) => ({
  objects: new Map(),
  objectsVersion: 0,
  sortedIds: [],

  viewport: { x: 0, y: 0, zoom: 1 },

  activeTool: restored.activeTool as Tool,
  pen: restored.pen,
  shape: DEFAULT_SHAPE,
  sticky: DEFAULT_STICKY,
  text: DEFAULT_TEXT,
  interaction: { type: 'IDLE' },
  selection: [],
  eraseCandidate: null,
  editingTextId: null,
  editingJustCreated: false,
  clipboard: [],

  draft: null,
  draftVersion: 0,

  setViewport: v => set({ viewport: { ...v, zoom: clampZoom(v.zoom) } }),

  /**
   * Pan by a SCREEN-space delta. R-COORD-007: mutates viewport.x/y only —
   * never object data, never hit-testing.
   */
  panBy: (dxScreen, dyScreen) =>
    set(s => ({
      viewport: { ...s.viewport, x: s.viewport.x + dxScreen, y: s.viewport.y + dyScreen },
    })),

  /**
   * Pointer-anchored zoom — R-COORD-005 (Blocking), FR-CANVAS-003.
   * Delegates to the shared helper so the maths exists exactly once
   * (R-COORD-004). Centre-anchored zoom feels broken and is non-negotiable.
   */
  zoomAt: (screenX, screenY, factor) =>
    set(s => ({
      viewport: zoomAtPoint(s.viewport, screenPoint(screenX, screenY), factor),
    })),

  setZoom: (zoom, anchorX, anchorY) =>
    set(s => {
      const target = clampZoom(zoom)
      return {
        viewport: zoomAtPoint(
          s.viewport,
          screenPoint(anchorX, anchorY),
          target / s.viewport.zoom,
        ),
      }
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

  setShape: patch => set(s => ({ shape: { ...s.shape, ...patch } })),
  setSticky: patch => set(s => ({ sticky: { ...s.sticky, ...patch } })),
  setText: patch => set(s => ({ text: { ...s.text, ...patch } })),

  beginTextEdit: (id, justCreated) =>
    set({
      editingTextId: id,
      editingJustCreated: justCreated,
      interaction: { type: 'EDITING_TEXT', objectId: id },
    }),

  endTextEdit: () =>
    set(s =>
      s.editingTextId === null
        ? {}
        : {
            editingTextId: null,
            editingJustCreated: false,
            interaction:
              s.interaction.type === 'EDITING_TEXT' ? { type: 'IDLE' } : s.interaction,
          },
    ),

  setClipboard: objects => set({ clipboard: objects }),

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

      const sortedIds = s.sortedIds.slice()
      insertByZ(sortedIds, s.objects, clamped)

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

  clearDraft: () =>
    set(s => (s.draft === null ? {} : { draft: null, draftVersion: s.draftVersion + 1 })),

  /**
   * Replace many objects at once — the drag, resize and rotate commit path.
   *
   * FLOWS E-07 is the reason this takes an array rather than being called in a
   * loop: dragging 500 objects must be ONE operation. In Phase 9 that becomes
   * one batched socket message; in Phase 6, one undo entry (R-UNDO-004). Here
   * it is one store commit and therefore one renderer repaint, instead of 500.
   *
   * R-STATE-002: the Map is mutated in place and `objectsVersion` bumped. A
   * fresh 10,000-entry Map per pointermove is a visible stutter.
   *
   * `sortedIds` is untouched: an update changes geometry, never z-order.
   */
  updateObjects: objects =>
    set(s => {
      if (objects.length === 0) return {}
      for (const o of objects) {
        if (!s.objects.has(o.id)) continue
        s.objects.set(o.id, { ...o, x: clampCoordValue(o.x), y: clampCoordValue(o.y) })
      }
      return { objectsVersion: s.objectsVersion + 1 }
    }),

  /**
   * Delete many objects at once — FR-CANVAS-014, and the eraser's commit path.
   *
   * The undoable route is `applyAndEmit` with DELETE ops, which is what every
   * caller of the delete key, the context menu and the properties panel now
   * takes. This remains the raw mutator underneath it, plus the eraser's
   * "remove it from under the cursor now, record the sweep on pointerup" path,
   * where the history entry is pushed once for the whole drag (R-UNDO-004).
   */
  deleteObjects: ids =>
    set(s => {
      const removed = new Set<ObjectId>()
      for (const id of ids) {
        if (s.objects.delete(id)) removed.add(id)
      }
      if (removed.size === 0) return {}

      return {
        sortedIds: s.sortedIds.filter(id => !removed.has(id)),
        selection: s.selection.filter(id => !removed.has(id)),
        eraseCandidate:
          s.eraseCandidate && removed.has(s.eraseCandidate) ? null : s.eraseCandidate,
        objectsVersion: s.objectsVersion + 1,
      }
    }),

  /**
   * Apply a batch of ops — TRD §5.2, §8.
   *
   * The single document write path shared by local commits (`applyAndEmit`),
   * undo, redo and, from Phase 9, remote ops (`applyRemoteOp`). Sharing it is
   * the point: a bug in how an UPDATE merges is then one bug, in one place,
   * rather than a divergence between what the author sees and what everyone
   * else does.
   *
   * R-CONV-002 (Blocking): an UPDATE payload is PARTIAL and merges only the
   * fields it names. Replacing the whole object would turn every concurrent
   * edit into a lost update.
   *
   * This is a COMMIT-BOUNDARY path — pointerup, a keypress, an arriving batch.
   * It is never the 60 Hz path; `updateObjects` remains that. The z-order
   * bookkeeping below would be too expensive per frame and does not need to be
   * cheap here.
   */
  applyOps: ops =>
    set(s => {
      if (ops.length === 0) return {}

      const touched = new Set<ObjectId>()
      let zDirty = false

      for (const op of ops) {
        const id = op.objectId as ObjectId
        touched.add(id)

        switch (op.type) {
          case 'CREATE': {
            const raw = op.payload as BoardObject
            const previous = s.objects.get(raw.id)
            const object = {
              ...raw,
              x: clampCoordValue(raw.x),
              y: clampCoordValue(raw.y),
            }
            // A CREATE for an id already present is a resurrection whose
            // z-index may differ from the one already in the cached order.
            if (previous && previous.zIndex !== object.zIndex) zDirty = true
            s.objects.set(object.id, object)
            break
          }

          case 'UPDATE': {
            const before = s.objects.get(id)
            // R-UNDO-005 / R-SYNC-021: an update naming an object that is not
            // here is dropped, never used to conjure a partial object.
            if (!before) break
            const merged = {
              ...before,
              ...(op.payload as Partial<BoardObject>),
            } as BoardObject
            if (merged.zIndex !== before.zIndex) zDirty = true
            s.objects.set(id, {
              ...merged,
              x: clampCoordValue(merged.x),
              y: clampCoordValue(merged.y),
            })
            break
          }

          case 'DELETE':
            s.objects.delete(id)
            break
        }
      }

      /*
       * Rebuild the cached z-order only as much as the batch actually
       * disturbed it.
       *
       * A full re-sort is correct for all three cases and would be four lines
       * shorter, but it is O(n log n) on every stroke commit, and on the
       * 10,000-object stress board that lands inside the ≤16 ms input-to-pixel
       * budget at exactly the moment the user is watching the line settle.
       * A create splices; a delete filters; only a z-index change re-sorts,
       * and that happens on bring-to-front, which nobody does sixty times a
       * second.
       */
      let sortedIds = s.sortedIds
      if (zDirty) {
        sortedIds = [...s.objects.values()]
          .sort((a, b) => (a.zIndex < b.zIndex ? -1 : a.zIndex > b.zIndex ? 1 : 0))
          .map(o => o.id)
      } else {
        const listed = new Set(s.sortedIds)
        const gone = new Set<ObjectId>()
        const fresh: BoardObject[] = []
        for (const id of touched) {
          const object = s.objects.get(id)
          if (!object && listed.has(id)) gone.add(id)
          else if (object && !listed.has(id)) fresh.push(object)
        }
        if (gone.size > 0) sortedIds = sortedIds.filter(id => !gone.has(id))
        if (fresh.length > 0) {
          sortedIds = sortedIds === s.sortedIds ? sortedIds.slice() : sortedIds
          for (const object of fresh) insertByZ(sortedIds, s.objects, object)
        }
      }

      const removedAny = sortedIds.length < s.sortedIds.length || zDirty
      const selection = removedAny
        ? s.selection.filter(id => s.objects.has(id))
        : s.selection

      return {
        sortedIds,
        objectsVersion: s.objectsVersion + 1,
        ...(selection.length === s.selection.length ? {} : { selection }),
        ...(s.eraseCandidate && !s.objects.has(s.eraseCandidate)
          ? { eraseCandidate: null }
          : {}),
      }
    }),

  /**
   * Rebuild `sortedIds` from the objects' zIndex values.
   *
   * Only needed when z-order CHANGES — `updateObjects` deliberately leaves the
   * cached order alone, because a drag changes geometry thousands of times and
   * re-sorting 10,000 ids on each of those frames would be the whole frame
   * budget spent on an order that did not move.
   */
  reorder: () =>
    set(s => ({
      sortedIds: [...s.objects.values()]
        .sort((a, b) => (a.zIndex < b.zIndex ? -1 : a.zIndex > b.zIndex ? 1 : 0))
        .map(o => o.id),
      objectsVersion: s.objectsVersion + 1,
    })),

  setSelection: ids =>
    set(s => {
      // Reference stability matters: `selection` drives React re-renders via
      // narrow selectors, and a fresh array for an unchanged selection would
      // re-render the properties panel on every pointermove of a drag.
      if (sameIds(s.selection, ids)) return {}
      return { selection: [...ids] }
    }),

  toggleSelection: id =>
    set(s => ({
      selection: s.selection.includes(id)
        ? s.selection.filter(x => x !== id)
        : [...s.selection, id],
    })),

  clearSelection: () => set(s => (s.selection.length === 0 ? {} : { selection: [] })),

  /** FR-CANVAS-022: ALL objects, not just the visible ones. */
  selectAll: () => set(s => ({ selection: [...s.sortedIds] })),

  setEraseCandidate: id =>
    set(s => (s.eraseCandidate === id ? {} : { eraseCandidate: id })),
}))

/**
 * Splice one id into the cached z-order at its lexicographic position.
 *
 * Binary search rather than a re-sort: a board is appended to thousands of
 * times over a session and re-sorting 10,000 ids per stroke is O(n log n) on
 * the commit frame, where the ≤16 ms input-to-pixel budget is already spoken
 * for. Mutates `sortedIds`, which is always a copy by the time it gets here —
 * React-side consumers may be holding the original.
 */
function insertByZ(
  sortedIds: ObjectId[],
  objects: Map<ObjectId, BoardObject>,
  object: BoardObject,
): void {
  let lo = 0
  let hi = sortedIds.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const z = objects.get(sortedIds[mid]!)?.zIndex ?? ''
    if (z <= object.zIndex) lo = mid + 1
    else hi = mid
  }
  sortedIds.splice(lo, 0, object.id)
}

/** Order-sensitive id comparison, used to avoid pointless selection writes. */
function sameIds(a: readonly ObjectId[], b: readonly ObjectId[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** The selected objects, in z-order. Non-React path — renderer and handlers. */
export function selectedObjects(): BoardObject[] {
  const { objects, sortedIds, selection } = useBoardStore.getState()
  if (selection.length === 0) return []
  const wanted = new Set(selection)
  const out: BoardObject[] = []
  for (const id of sortedIds) {
    const o = objects.get(id)
    if (o && wanted.has(id)) out.push(o)
  }
  return out
}

/** All objects in z-order. Shared by hit testing and the renderer. */
export function objectsInZOrder(): BoardObject[] {
  const { objects, sortedIds } = useBoardStore.getState()
  const out: BoardObject[] = []
  for (const id of sortedIds) {
    const o = objects.get(id)
    if (o) out.push(o)
  }
  return out
}

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
