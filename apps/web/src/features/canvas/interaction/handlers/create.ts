import {
  MIN_OBJECT_SIZE,
  STICKY_COLOURS,
  STICKY_DEFAULT_SIZE,
  clampCoord,
  type BoardObject,
  type ObjectId,
  type Rect,
  type ShapeObject,
  type StickyObject,
  type TextObject,
} from '@coboard/shared'
import { boardStore, nextZIndex, type Tool } from '../../../../stores/boardStore.js'
import { canTransition } from '../machine.js'
import { releaseCapture } from './select.js'

/**
 * Object creation — FR-CANVAS-007 (shapes), 008 (sticky), 009 (text).
 *
 * Shapes are drag-defined: pointerdown fixes one corner, the drag defines the
 * box, pointerup commits. Sticky notes and text are click-placed and go
 * straight into edit mode, because FR-CANVAS-008 requires "click and type
 * without a second action".
 */

const LOCAL_AUTHOR = 'local'

export type ShapeTool = 'rect' | 'ellipse' | 'line' | 'arrow'

const SHAPE_TOOL_LIST: readonly ShapeTool[] = ['rect', 'ellipse', 'line', 'arrow']
export const SHAPE_TOOLS: ReadonlySet<Tool> = new Set<Tool>(SHAPE_TOOL_LIST)

export const isShapeTool = (t: Tool): t is ShapeTool =>
  (SHAPE_TOOL_LIST as readonly string[]).includes(t)

/** Fields every new object shares. */
function base(box: Rect, id: ObjectId) {
  const now = Date.now()
  return {
    id,
    x: clampCoord(box.x),
    y: clampCoord(box.y),
    width: box.width,
    height: box.height,
    rotation: 0,
    zIndex: nextZIndex(),
    opacity: 1,
    createdBy: LOCAL_AUTHOR,
    // R-CONV-010: display only. Ordering is the server's sequence number.
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * The box a drag defines, with the FR-CANVAS-007 modifiers.
 *
 * Shift constrains to a square, a circle, or a 45°-snapped line; Alt draws
 * from the centre outward. Both compose.
 */
export function shapeBox(
  tool: Tool,
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
  shift: boolean,
  alt: boolean,
): Rect {
  let dx = currentX - startX
  let dy = currentY - startY

  if (shift) {
    if (tool === 'line' || tool === 'arrow') {
      // Snap the DIRECTION to the nearest 45°, preserving the drag's length,
      // so a "horizontal" line is exactly horizontal rather than nearly so.
      const length = Math.hypot(dx, dy)
      const step = Math.PI / 4
      const angle = Math.round(Math.atan2(dy, dx) / step) * step
      dx = Math.cos(angle) * length
      dy = Math.sin(angle) * length
    } else {
      // Square or circle: the longer axis wins, so the shape tracks the
      // direction the user is actually pulling.
      const size = Math.max(Math.abs(dx), Math.abs(dy))
      dx = Math.sign(dx || 1) * size
      dy = Math.sign(dy || 1) * size
    }
  }

  if (alt) {
    // From the centre: the drag defines the half-extent in each direction.
    return {
      x: startX - Math.abs(dx),
      y: startY - Math.abs(dy),
      width: Math.abs(dx) * 2,
      height: Math.abs(dy) * 2,
    }
  }

  return {
    x: Math.min(startX, startX + dx),
    y: Math.min(startY, startY + dy),
    width: Math.abs(dx),
    height: Math.abs(dy),
  }
}

/**
 * Build the object a tool creates for a given box. Exported so the interaction
 * layer can render the in-progress shape with the exact renderer that will
 * draw it once committed — no preview that looks different from the result.
 */
export function buildObject(tool: Tool, box: Rect, id: ObjectId): BoardObject | null {
  const { shape, sticky, text } = boardStore.getState()

  switch (tool) {
    case 'rect':
    case 'ellipse':
    case 'line':
    case 'arrow':
      return {
        ...base(box, id),
        type: tool,
        stroke: shape.stroke,
        strokeWidth: shape.strokeWidth,
        // A line or arrow has no interior to fill; forcing 'none' keeps the
        // stored object consistent with what is drawn.
        fill: tool === 'line' || tool === 'arrow' ? 'none' : shape.fill,
        ...(tool === 'rect' ? { cornerRadius: shape.cornerRadius } : {}),
        ...(tool === 'arrow' ? { arrowEnd: true, arrowStart: false } : {}),
        opacity: shape.opacity,
      } as ShapeObject

    case 'sticky':
      return {
        ...base(box, id),
        type: 'sticky',
        text: '',
        color: sticky.color,
        // FR-CANVAS-008: auto-shrink is the default, so a note the user
        // resizes reflows instead of clipping.
        fontSize: 'auto',
        textAlign: 'center',
      } as StickyObject

    case 'text':
      return {
        ...base(box, id),
        type: 'text',
        text: '',
        color: text.color,
        fontSize: text.fontSize,
        bold: text.bold,
        italic: text.italic,
        textAlign: text.textAlign,
      } as TextObject

    default:
      return null
  }
}

/* ── Drag-created shapes ──────────────────────────────────────────────────── */

export function beginCreate(
  pointerId: number,
  tool: ShapeTool,
  x: number,
  y: number,
): boolean {
  const { interaction, setInteraction } = boardStore.getState()
  if (!canTransition(interaction.type, 'CREATING')) return false

  setInteraction({
    type: 'CREATING',
    pointerId,
    tool,
    startX: x,
    startY: y,
    box: { x, y, width: 0, height: 0 },
  })
  return true
}

export function updateCreate(x: number, y: number, shift: boolean, alt: boolean): void {
  const { interaction, setInteraction } = boardStore.getState()
  if (interaction.type !== 'CREATING') return
  setInteraction({
    ...interaction,
    box: shapeBox(
      interaction.tool,
      interaction.startX,
      interaction.startY,
      x,
      y,
      shift,
      alt,
    ),
  })
}

/**
 * Commit the shape. Returns the created object, or null when the gesture was
 * too small to be one.
 */
export function endCreate(element: Element | null): BoardObject | null {
  const state = boardStore.getState()
  const { interaction } = state
  if (interaction.type !== 'CREATING') return null

  releaseCapture(element, interaction.pointerId)
  state.setInteraction({ type: 'IDLE' })

  const box = interaction.box
  const isLinear = interaction.tool === 'line' || interaction.tool === 'arrow'
  // A line may legitimately be zero-height; a rect may not be zero-anything.
  // Either way a click that never became a drag creates nothing, rather than
  // leaving an 8x8 speck the user did not ask for.
  const span = isLinear
    ? Math.hypot(box.width, box.height)
    : Math.min(box.width, box.height)
  if (span < MIN_OBJECT_SIZE) return null

  const object = buildObject(interaction.tool, box, crypto.randomUUID() as ObjectId)
  if (!object) return null

  state.addObject(object)
  state.setSelection([object.id])
  // PHASE 6 SLOT: one history entry { forward:[CREATE], inverse:[DELETE] }.
  // PHASE 9 SLOT: emit op:create and add to the outbox.
  return object
}

export function cancelCreate(element: Element | null): void {
  const { interaction, setInteraction } = boardStore.getState()
  if (interaction.type !== 'CREATING') return
  releaseCapture(element, interaction.pointerId)
  setInteraction({ type: 'IDLE' })
}

/* ── Click-placed sticky notes and text ───────────────────────────────────── */

/**
 * Place a sticky note or text object and enter edit mode immediately —
 * FLOWS §8.2.2 step 2.
 *
 * "The user should be able to click and type without a second action", so
 * this both creates the object and opens the editor. The note is a real object
 * from the moment it exists; the empty-discard on blur is what keeps the board
 * clean (step 4).
 */
export function placeAndEdit(
  tool: 'sticky' | 'text',
  x: number,
  y: number,
): BoardObject | null {
  const state = boardStore.getState()
  if (state.interaction.type !== 'IDLE') return null

  const box: Rect =
    tool === 'sticky'
      ? {
          // FR-CANVAS-008: 200x200, "centred on the cursor".
          x: x - STICKY_DEFAULT_SIZE / 2,
          y: y - STICKY_DEFAULT_SIZE / 2,
          width: STICKY_DEFAULT_SIZE,
          height: STICKY_DEFAULT_SIZE,
        }
      : // Text starts as a single line's worth of box and grows as it wraps.
        { x, y, width: 240, height: state.text.fontSize * 1.35 }

  const object = buildObject(tool, box, crypto.randomUUID() as ObjectId)
  if (!object) return null

  state.addObject(object)
  state.setSelection([object.id])
  state.beginTextEdit(object.id, true)
  return object
}

/** The 8 frozen sticky colours, in palette order — R-UI-014. */
export const STICKY_COLOUR_LIST = Object.entries(STICKY_COLOURS).map(([name, value]) => ({
  name,
  value,
}))
