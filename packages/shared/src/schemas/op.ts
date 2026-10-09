/**
 * Operation schemas. TRD §5.2, §5.4.
 *
 * An op is an atomic, immutable change: create, update, delete. Ops are what
 * travel over the wire and what get stored in the log.
 *
 * R-CONV-002 (Blocking): UPDATE payloads are PARTIAL. Only the fields being
 * changed are sent, and the merge replaces only those fields. Sending the full
 * object on every update turns every concurrent edit into a lost update.
 */

import { z } from 'zod'
import { OP_PAYLOAD_MAX_BYTES } from '../constants.js'
import {
  BoardObjectSchema,
  ImageObjectSchema,
  ShapeObjectSchema,
  StickyObjectSchema,
  StrokeObjectSchema,
  TextObjectSchema,
  type ObjectType,
} from './object.js'

export const OpTypeSchema = z.enum(['CREATE', 'UPDATE', 'DELETE'])
export type OpType = z.infer<typeof OpTypeSchema>

/**
 * The fields an UPDATE may carry, per object type: every field of that type's
 * schema EXCEPT `id` and `type`, each optional, with the type's own bounds,
 * and nothing else (`.strict()` — an unknown key is refused, not stripped).
 *
 * `id` and `type` are forbidden because neither may change: a changed id
 * forks the object from its op history, and a changed type turns a sticky
 * into an image that has no `url`.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  WHY PER-FIELD VALIDATION IS ENOUGH.                                     │
 * │                                                                          │
 * │  The object schemas have NO cross-field refinements — every field is     │
 * │  bounded on its own. So "the stored object is valid, and every key of    │
 * │  this partial is a valid value of that key FOR THE OBJECT'S TYPE" is     │
 * │  exactly equivalent to "the merged object re-parses". The server checks  │
 * │  the update against the target's type (OpService), which lets it skip    │
 * │  materialising the object on every op. If a refinement is ever added to  │
 * │  an object schema, this equivalence breaks and the server must re-parse  │
 * │  the merged object instead — there is a test pinning that.               │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
const ID_AND_TYPE = { id: true, type: true } as const

const ShapeUpdateSchema = ShapeObjectSchema.omit(ID_AND_TYPE).partial().strict()

export const UpdatePayloadByType = {
  stroke: StrokeObjectSchema.omit(ID_AND_TYPE).partial().strict(),
  rect: ShapeUpdateSchema,
  ellipse: ShapeUpdateSchema,
  line: ShapeUpdateSchema,
  arrow: ShapeUpdateSchema,
  sticky: StickyObjectSchema.omit(ID_AND_TYPE).partial().strict(),
  text: TextObjectSchema.omit(ID_AND_TYPE).partial().strict(),
  image: ImageObjectSchema.omit(ID_AND_TYPE).partial().strict(),
} as const satisfies Record<ObjectType, z.ZodTypeAny>

/**
 * The wire-level UPDATE payload: a strict partial over the UNION of every
 * type's fields. A key two types share with different rules (`color`,
 * `fontSize`, `text`, `cornerRadius`) accepts either rule here, because the
 * wire schema cannot know the target's type; the server narrows to the exact
 * type before persisting. What this schema already guarantees on its own: no
 * unknown key, no `id` or `type`, and no value outside the bounds of at least
 * one object type — so `{x: 1e309}` or `{points: null}` never get this far.
 */
function unionShape(): z.ZodRawShape {
  const byKey = new Map<string, z.ZodTypeAny[]>()
  const seen = new Set<z.ZodTypeAny>()
  for (const schema of Object.values(UpdatePayloadByType)) {
    if (seen.has(schema)) continue
    seen.add(schema)
    for (const [key, field] of Object.entries(schema.shape as z.ZodRawShape)) {
      // `.partial()` wrapped every field in ZodOptional; unwrap so the union
      // below is over the real types (the final `.partial()` re-wraps once).
      const inner =
        field instanceof z.ZodOptional ? (field.unwrap() as z.ZodTypeAny) : field
      const bare =
        inner instanceof z.ZodOptional ? (inner.unwrap() as z.ZodTypeAny) : inner
      byKey.set(key, [...(byKey.get(key) ?? []), bare])
    }
  }
  const shape: z.ZodRawShape = {}
  for (const [key, options] of byKey) {
    shape[key] =
      options.length === 1
        ? options[0]!
        : z.union(options as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
  }
  return shape
}

/**
 * Typed as a plain record on purpose: the client builds UPDATE payloads by
 * diffing objects of any type (inverseOps.ts), and a key-precise type over a
 * union of eight object types buys nothing at those call sites. The RUNTIME
 * schema is the strict one.
 */
export const UpdatePayloadSchema: z.ZodType<
  Record<string, unknown>,
  z.ZodTypeDef,
  unknown
> = z.object(unionShape()).partial().strict()

export type UpdatePayload = Record<string, unknown>

/** UTF-8 length of the serialized payload. */
const payloadBytes = (payload: unknown): number =>
  new TextEncoder().encode(JSON.stringify(payload) ?? '').length

const ClientOpShapeSchema = z.discriminatedUnion('type', [
  z.object({
    /** Client-generated uuid — the idempotency key (R-SYNC-014). */
    id: z.string().uuid(),
    type: z.literal('CREATE'),
    objectId: z.string().uuid(),
    payload: BoardObjectSchema,
  }),
  z.object({
    id: z.string().uuid(),
    type: z.literal('UPDATE'),
    objectId: z.string().uuid(),
    payload: UpdatePayloadSchema,
  }),
  z.object({
    id: z.string().uuid(),
    type: z.literal('DELETE'),
    objectId: z.string().uuid(),
    payload: z.object({}).strict(),
  }),
])

/**
 * An op as a client sends it — what the server validates every inbound op
 * against (TRD §5.4 step 2).
 *
 * Two rules the per-type shapes cannot express:
 *  - a CREATE's `payload.id` IS its `objectId`. Otherwise the op log files
 *    the object under one id and every client stores it under another, and
 *    the first UPDATE or DELETE addressed to it lands on nothing.
 *  - the serialized payload is at most OP_PAYLOAD_MAX_BYTES.
 */
export const ClientOpSchema = ClientOpShapeSchema.superRefine((op, ctx) => {
  if (op.type === 'CREATE' && op.payload.id !== op.objectId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['payload', 'id'],
      message: 'A CREATE payload id must equal its objectId',
    })
  }
  if (op.type !== 'DELETE' && payloadBytes(op.payload) > OP_PAYLOAD_MAX_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.too_big,
      path: ['payload'],
      type: 'string',
      maximum: OP_PAYLOAD_MAX_BYTES,
      inclusive: true,
      message: `Payload exceeds ${OP_PAYLOAD_MAX_BYTES} bytes`,
    })
  }
})

export type ClientOp = z.infer<typeof ClientOpSchema>

/**
 * An op as the SERVER sends it. Deliberately more lenient on UPDATE payloads
 * than `ClientOpSchema`: the client parses every inbound `op_batch` against
 * this (SocketClient), and one historical op stored before the strict schema
 * existed must not make it drop a whole batch and diverge. Strictness belongs
 * at the door the data comes IN through, which is the server's.
 */
const ServerClientOpSchema = z.discriminatedUnion('type', [
  ClientOpShapeSchema.options[0],
  ClientOpShapeSchema.options[1].extend({ payload: z.record(z.string(), z.unknown()) }),
  ClientOpShapeSchema.options[2],
])

export const ServerOpSchema = z.intersection(
  ServerClientOpSchema,
  z.object({
    /** Server-assigned, monotonic per board. The sole ordering authority. */
    seq: z.number().int().positive(),
    actorSessionId: z.string().min(1),
  }),
)

export type ServerOp = z.infer<typeof ServerOpSchema>

/** Nack codes. Never batched — errors go out immediately (R-SYNC-016). */
export const NACK_CODES = {
  FORBIDDEN: 'FORBIDDEN',
  INVALID_OP: 'INVALID_OP',
  RATE_LIMITED: 'RATE_LIMITED',
  BOARD_GONE: 'BOARD_GONE',
} as const

export type NackCode = (typeof NACK_CODES)[keyof typeof NACK_CODES]
