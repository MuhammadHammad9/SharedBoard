/**
 * Board and membership schemas. TRD §4.2, §4.3.
 */

import { z } from 'zod'
import { BOARD_NAME_MAX, ROLES } from '../constants.js'

export const RoleSchema = z.enum(ROLES)

export const BoardNameSchema = z
  .string()
  .transform(s => s.trim())
  .pipe(z.string().min(1).max(BOARD_NAME_MAX))

export const CreateBoardSchema = z.object({
  name: BoardNameSchema.optional(),
  templateId: z.string().max(64).optional(),
})

export const UpdateBoardSchema = z.object({
  name: BoardNameSchema.optional(),
})

export const BoardFilterSchema = z.enum(['all', 'owned', 'shared', 'starred'])
export const BoardSortSchema = z.enum(['lastEdited', 'created', 'name'])

export const ListBoardsQuerySchema = z.object({
  filter: BoardFilterSchema.default('all'),
  sort: BoardSortSchema.default('lastEdited'),
  q: z.string().max(200).optional(),
  cursor: z.string().max(256).optional(),
})

/** Permanent delete requires an exact name match — FR-BOARD-006. */
export const PermanentDeleteSchema = z.object({
  confirmName: z.string().min(1).max(BOARD_NAME_MAX),
})

export const AccessQuerySchema = z.object({
  shareToken: z.string().max(256).optional(),
  guestId: z.string().uuid().optional(),
})

/** Drives the requireBoardAccess guard — FLOWS §2.3 STEP 4. */
export const AccessResponseSchema = z.object({
  role: z.union([RoleSchema, z.literal('none')]),
  joinable: z.boolean().optional(),
  requiresName: z.boolean().optional(),
})

export const InviteMembersSchema = z.object({
  emails: z.array(z.string().email()).min(1).max(50),
  /** Never OWNER — a board has exactly one owner (FR-SHARE-001). */
  role: z.enum(['EDITOR', 'VIEWER']),
})

export const UpdateMemberSchema = z.object({
  role: z.enum(['EDITOR', 'VIEWER']),
})

export const CreateShareLinkSchema = z.object({
  role: z.enum(['EDITOR', 'VIEWER']),
})

export const JoinViaShareSchema = z.object({
  guestId: z.string().uuid(),
  name: z
    .string()
    .transform(s => s.trim())
    .pipe(z.string().min(1).max(40)),
})

/** Single error envelope used by every endpoint — TRD §4. */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    correlationId: z.string(),
  }),
})

// `Role` is exported from ../constants.js — the single definition (R-ARCH-007).
export type CreateBoardInput = z.infer<typeof CreateBoardSchema>
export type ListBoardsQuery = z.infer<typeof ListBoardsQuerySchema>
export type AccessResponse = z.infer<typeof AccessResponseSchema>
export type ApiError = z.infer<typeof ApiErrorSchema>
