/**
 * Auth schemas, shared by the server and by React Hook Form on the client.
 *
 * Validation copy is NOT defined here — it lives in apps/web/src/lib/strings.ts
 * per R-UI-052, and is mapped onto these issues at the form layer.
 */

import { z } from 'zod'
import {
  DISPLAY_NAME_MAX,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../constants.js'

/** RFC 5322 pragmatic subset, per FR-AUTH-001. */
export const EmailSchema = z
  .string()
  .min(3)
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)

/** FR-AUTH-001: min 8, at least one letter and one number, max 128. */
export const PasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH)
  .max(PASSWORD_MAX_LENGTH)
  .regex(/[A-Za-z]/, 'needs a letter')
  .regex(/[0-9]/, 'needs a number')

/** 1–40 characters, trimmed, non-empty after trim. */
export const DisplayNameSchema = z
  .string()
  .transform(s => s.trim())
  .pipe(z.string().min(1).max(DISPLAY_NAME_MAX))

export const RegisterSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  displayName: DisplayNameSchema,
})

export const LoginSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
})

export const ForgotPasswordSchema = z.object({ email: EmailSchema })

export const ResetPasswordSchema = z.object({
  token: z.string().min(1).max(512),
  password: PasswordSchema,
})

/** Guest identity, persisted to localStorage under `coboard.guest`. */
export const GuestIdentitySchema = z.object({
  id: z.string().uuid(),
  name: DisplayNameSchema,
  colour: z.string().regex(/^#[0-9a-fA-F]{6}$/),
})

export type RegisterInput = z.infer<typeof RegisterSchema>
export type LoginInput = z.infer<typeof LoginSchema>
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>
export type GuestIdentity = z.infer<typeof GuestIdentitySchema>

/**
 * The user as the client is allowed to see it.
 *
 * Named `PublicUser` rather than `User` deliberately: the Prisma row carries
 * `passwordHash`, `googleId` and `emailLower`, and none of those may ever
 * reach a response body. Having one schema whose whole job is "what leaves the
 * server" means the redaction happens in a single place instead of being
 * re-remembered at every endpoint.
 */
export const PublicUserSchema = z.object({
  id: z.string().uuid(),
  email: EmailSchema,
  displayName: z.string().min(1).max(DISPLAY_NAME_MAX),
  avatarUrl: z.string().url().nullable(),
  /** True once a password has been set; false for an OAuth-only account. */
  hasPassword: z.boolean(),
  createdAt: z.string(),
})

export type PublicUser = z.infer<typeof PublicUserSchema>

/** POST /auth/register and /auth/login. The refresh token rides in a cookie. */
export const AuthResponseSchema = z.object({
  user: PublicUserSchema,
  accessToken: z.string().min(1),
})

export type AuthResponse = z.infer<typeof AuthResponseSchema>

export const RefreshResponseSchema = z.object({ accessToken: z.string().min(1) })

export const UpdateProfileSchema = z.object({
  displayName: DisplayNameSchema.optional(),
  avatarUrl: z.string().url().max(2048).nullable().optional(),
})

export const ChangePasswordSchema = z.object({
  /** Optional: an OAuth-only account is SETTING a password, not changing one. */
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH).optional(),
  newPassword: PasswordSchema,
})

/**
 * Deleting an account requires typing the exact display name — FR-SET-001.
 * Checked server-side too: a client-only confirmation is theatre.
 */
export const DeleteAccountSchema = z.object({ confirm: z.string().min(1).max(200) })

export type UpdateProfileInput = z.infer<typeof UpdateProfileSchema>
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>
