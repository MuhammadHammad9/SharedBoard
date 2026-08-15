/**
 * The WebSocket message contract. TRD §5.2.
 *
 * Imported by BOTH client and server (R-ARCH-007). Keys are terse because
 * these fly at 20 Hz per user.
 *
 * R-SYNC-001 (Blocking): ops and presence are different categories.
 *   Ops are persisted, sequenced, acknowledged and queued offline.
 *   Presence is never persisted, never sequenced, never acked, dropped offline.
 */

import { z } from 'zod'
import { ClientOpSchema, ServerOpSchema } from './schemas/op.js'
import { RoleSchema } from './schemas/board.js'

export const PresenceUserSchema = z.object({
  sessionId: z.string(),
  userId: z.string().nullable(),
  guestId: z.string().nullable(),
  name: z.string(),
  colour: z.string(),
  role: RoleSchema,
})

export type PresenceUser = z.infer<typeof PresenceUserSchema>

/* ── Client → Server ──────────────────────────────────────────────────────── */

export const ClientMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('join'),
    boardId: z.string().uuid(),
    sinceSeq: z.number().int().nonnegative(),
  }),
  z.object({ t: z.literal('op'), op: ClientOpSchema }),
  z.object({ t: z.literal('op_batch'), ops: z.array(ClientOpSchema).min(1).max(100) }),
  // Presence — never persisted
  z.object({ t: z.literal('cursor'), x: z.number().finite(), y: z.number().finite() }),
  z.object({ t: z.literal('sel'), ids: z.array(z.string().uuid()).max(5_000) }),
  z.object({
    t: z.literal('stroke'),
    id: z.string().uuid(),
    pts: z.array(z.number().finite()).max(3_000),
    done: z.boolean(),
  }),
  z.object({
    t: z.literal('xform'),
    ids: z.array(z.string().uuid()).max(5_000),
    dx: z.number().finite(),
    dy: z.number().finite(),
  }),
  z.object({ t: z.literal('ping') }),
])

export type ClientMessage = z.infer<typeof ClientMessageSchema>

/* ── Server → Client ──────────────────────────────────────────────────────── */

export const ServerMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('join_ack'),
    seq: z.number().int().nonnegative(),
    role: RoleSchema,
    sessionId: z.string(),
    colour: z.string(),
    users: z.array(PresenceUserSchema),
  }),
  z.object({ t: z.literal('op_batch'), ops: z.array(ServerOpSchema) }),
  z.object({
    t: z.literal('ack'),
    ids: z.array(z.string()),
    seqs: z.array(z.number().int().positive()),
  }),
  z.object({
    t: z.literal('nack'),
    id: z.string(),
    code: z.string(),
    message: z.string(),
  }),
  z.object({ t: z.literal('presence_join'), user: PresenceUserSchema }),
  z.object({ t: z.literal('presence_leave'), sessionId: z.string() }),
  z.object({
    t: z.literal('cursor'),
    sessionId: z.string(),
    x: z.number().finite(),
    y: z.number().finite(),
  }),
  z.object({ t: z.literal('sel'), sessionId: z.string(), ids: z.array(z.string()) }),
  z.object({
    t: z.literal('stroke'),
    sessionId: z.string(),
    id: z.string(),
    pts: z.array(z.number().finite()),
    done: z.boolean(),
  }),
  z.object({
    t: z.literal('xform'),
    sessionId: z.string(),
    ids: z.array(z.string()),
    dx: z.number().finite(),
    dy: z.number().finite(),
  }),
  z.object({ t: z.literal('board_renamed'), name: z.string() }),
  z.object({ t: z.literal('board_deleted') }),
  z.object({ t: z.literal('role_changed'), role: RoleSchema }),
  z.object({ t: z.literal('access_revoked') }),
  z.object({ t: z.literal('pong') }),
])

export type ServerMessage = z.infer<typeof ServerMessageSchema>

/** Message types that are presence, not ops. Dropped when offline. */
export const PRESENCE_MESSAGE_TYPES = ['cursor', 'sel', 'stroke', 'xform'] as const

export const isPresenceMessage = (t: string): boolean =>
  (PRESENCE_MESSAGE_TYPES as readonly string[]).includes(t)

/** The six connection states — FLOWS §15.2, each maps to one header indicator. */
export const CONNECTION_STATES = [
  'disconnected',
  'connecting',
  'syncing',
  'connected',
  'reconnecting',
  'offline',
] as const

export type ConnectionState = (typeof CONNECTION_STATES)[number]
