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
