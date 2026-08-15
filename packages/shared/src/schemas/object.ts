/**
 * Zod schemas for board objects. TRD §3.3, §11.3.
 *
 * R-SEC-003 (Blocking): validate at the boundary. Reject, never coerce.
 * R-SEC-004 (Blocking): every numeric field has explicit finite bounds.
 *   NaN and Infinity are rejected by .finite(). An Infinity in a coordinate
 *   propagates through the renderer and blanks the canvas for EVERY user in
 *   the room — both a bug and a denial-of-service vector.
 */

import { z } from 'zod'
import {
  COORD_MAX,
  COORD_MIN,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  SIZE_MAX,
  STICKY_COLOUR_VALUES,
  STICKY_TEXT_MAX,
  STROKE_POINTS_MAX,
  STROKE_POINTS_MIN,
  STROKE_WIDTH_MAX,
  STROKE_WIDTH_MIN,
  TEXT_MAX,
} from '../constants.js'

const hexColour = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a #RRGGBB hex colour')

const coord = z.number().finite().min(COORD_MIN).max(COORD_MAX)
const size = z.number().finite().min(0).max(SIZE_MAX)

export const OBJECT_TYPES = [
  'stroke',
  'rect',
  'ellipse',
  'line',
  'arrow',
  'sticky',
  'text',
  'image',
] as const

export const TextAlignSchema = z.enum(['left', 'center', 'right'])

/** Fields shared by every object type. */
export const BaseObjectSchema = z.object({
  id: z.string().uuid(),
  x: coord,
  y: coord,
  width: size,
  height: size,
  rotation: z.number().finite().min(0).max(360),
  /** Fractional index — a STRING ordered lexicographically. TRD §6.4, D-8. */
  zIndex: z.string().min(1).max(64),
  opacity: z.number().finite().min(0).max(1),
  createdBy: z.string().min(1).max(64),
  /** Client ms timestamp. DISPLAY ONLY — never used for ordering (R-CONV-010). */
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
})

export const StrokeObjectSchema = BaseObjectSchema.extend({
  type: z.literal('stroke'),
  /** Flat array with stride 3: [x0,y0,p0, x1,y1,p1, ...]. TRD D-9. */
  points: z.array(z.number().finite()).min(STROKE_POINTS_MIN).max(STROKE_POINTS_MAX),
  color: hexColour,
  strokeWidth: z.number().finite().min(STROKE_WIDTH_MIN).max(STROKE_WIDTH_MAX),
  simplified: z.boolean(),
})

export const ShapeObjectSchema = BaseObjectSchema.extend({
  type: z.enum(['rect', 'ellipse', 'line', 'arrow']),
  stroke: hexColour,
  strokeWidth: z.number().finite().min(STROKE_WIDTH_MIN).max(STROKE_WIDTH_MAX),
  fill: z.union([hexColour, z.literal('none')]),
  cornerRadius: z.number().finite().min(0).max(SIZE_MAX).optional(),
  arrowStart: z.boolean().optional(),
  arrowEnd: z.boolean().optional(),
})

export const StickyObjectSchema = BaseObjectSchema.extend({
  type: z.literal('sticky'),
  text: z.string().max(STICKY_TEXT_MAX),
  /** One of the 8 frozen palette colours — R-UI-014. */
  color: z.enum(STICKY_COLOUR_VALUES as unknown as [string, ...string[]]),
  fontSize: z.union([
    z.number().finite().min(FONT_SIZE_MIN).max(FONT_SIZE_MAX),
    z.literal('auto'),
  ]),
  textAlign: TextAlignSchema,
})

export const TextObjectSchema = BaseObjectSchema.extend({
  type: z.literal('text'),
  text: z.string().max(TEXT_MAX),
  color: hexColour,
  fontSize: z.number().finite().min(FONT_SIZE_MIN).max(FONT_SIZE_MAX),
  bold: z.boolean(),
  italic: z.boolean(),
  textAlign: TextAlignSchema,
})

export const ImageObjectSchema = BaseObjectSchema.extend({
  type: z.literal('image'),
  /** A URL. Never base64 — FR-CANVAS-010. */
  url: z.string().url().max(2_048),
  naturalWidth: z.number().finite().positive().max(SIZE_MAX),
  naturalHeight: z.number().finite().positive().max(SIZE_MAX),
  cornerRadius: z.number().finite().min(0).max(SIZE_MAX),
})

export const BoardObjectSchema = z.discriminatedUnion('type', [
  StrokeObjectSchema,
  ShapeObjectSchema,
  StickyObjectSchema,
  TextObjectSchema,
  ImageObjectSchema,
])

export type BaseObject = z.infer<typeof BaseObjectSchema>
export type StrokeObject = z.infer<typeof StrokeObjectSchema>
export type ShapeObject = z.infer<typeof ShapeObjectSchema>
export type StickyObject = z.infer<typeof StickyObjectSchema>
export type TextObject = z.infer<typeof TextObjectSchema>
export type ImageObject = z.infer<typeof ImageObjectSchema>
export type BoardObject = z.infer<typeof BoardObjectSchema>
export type ObjectType = BoardObject['type']
