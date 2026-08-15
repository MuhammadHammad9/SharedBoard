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
import { BoardObjectSchema } from './object.js'

export const OpTypeSchema = z.enum(['CREATE', 'UPDATE', 'DELETE'])
export type OpType = z.infer<typeof OpTypeSchema>

/**
 * A partial object payload for UPDATE.
 *
 * Deliberately permissive on shape but strict on primitives: the full merged
 * object is re-validated against BoardObjectSchema after the field-level merge,
 * which is what actually guarantees the invariants.
 */
export const UpdatePayloadSchema = z.record(z.string(), z.unknown())

export const ClientOpSchema = z.discriminatedUnion('type', [
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

export type ClientOp = z.infer<typeof ClientOpSchema>

export const ServerOpSchema = z.intersection(
  ClientOpSchema,
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
