import { PEN_COLOURS, STICKY_COLOURS, type BoardObject } from '@coboard/shared'
import { selectedObjects } from '../../../../stores/boardStore.js'
import { applyAndEmit, updateOps } from '../../history/apply.js'
import { LABELS } from '../../history/grouping.js'

/**
 * "Change colour" — the FR-CANVAS-019 context-menu item.
 *
 * The PRD names the item and nothing more; which palette and which property
 * are fixed here and recorded as D-25:
 *
 *   - sticky notes → the 8 FROZEN sticky colours, written to `color`
 *     (R-UI-014: a sticky's colour is persisted data, so no other value is
 *     offered — the server would refuse it anyway);
 *   - strokes and text → the pen palette, written to `color`;
 *   - rect / ellipse / line / arrow → the pen palette, written to `stroke` —
 *     a shape's line is the colour it shows by default (fill starts "none"),
 *     and fill keeps its own control in the properties panel.
 *
 * A selection mixing sticky notes with anything else, or containing an image,
 * has no single palette, so the item is not offered. Showing it and silently
 * skipping part of the selection would be worse than not showing it.
 */

export interface ColourTarget {
  palette: ReadonlyArray<{ value: string; name?: string }>
  /** Every selected object's current colour, or undefined when they differ. */
  current: string | undefined
}

const STICKY_PALETTE = Object.entries(STICKY_COLOURS).map(([name, value]) => ({
  name,
  value,
}))
const PEN_PALETTE = PEN_COLOURS.map(value => ({ value }))

const colourOf = (o: BoardObject): string | undefined => {
  switch (o.type) {
    case 'sticky':
    case 'stroke':
    case 'text':
      return o.color
    case 'rect':
    case 'ellipse':
    case 'line':
    case 'arrow':
      return o.stroke
    default:
      return undefined
  }
}

const withColour = (o: BoardObject, colour: string): BoardObject => {
  switch (o.type) {
    case 'sticky':
    case 'stroke':
    case 'text':
      return { ...o, color: colour }
    case 'rect':
    case 'ellipse':
    case 'line':
    case 'arrow':
      return { ...o, stroke: colour }
    default:
      return o
  }
}

/** The palette "Change colour" offers for these objects, or null for none. */
export function colourTargetFor(objects: readonly BoardObject[]): ColourTarget | null {
  if (objects.length === 0) return null
  if (objects.some(o => o.type === 'image')) return null
  const stickies = objects.filter(o => o.type === 'sticky').length
  if (stickies > 0 && stickies < objects.length) return null

  const colours = new Set(objects.map(o => colourOf(o)?.toLowerCase()))
  const current = colours.size === 1 ? colourOf(objects[0]!) : undefined
  return { palette: stickies > 0 ? STICKY_PALETTE : PEN_PALETTE, current }
}

/**
 * Recolour the selection: ONE batched commit, ONE undo entry (R-UNDO-004),
 * and UPDATE payloads carrying only the changed key — `updateOps` diffs each
 * object, so an object already that colour produces no op at all.
 */
export function changeSelectionColour(colour: string): boolean {
  const objects = selectedObjects()
  if (!colourTargetFor(objects)) return false
  return applyAndEmit(
    updateOps(objects.map(o => ({ ...withColour(o, colour), updatedAt: Date.now() }))),
    LABELS.style,
  )
}
