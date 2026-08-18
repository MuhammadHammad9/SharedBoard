import { z } from 'zod'

/**
 * The error envelope — TRD §4.
 *
 * Every failing endpoint in the product returns this shape, which is why it
 * lives in `shared` rather than in the server: the client's error handling is
 * written against the same type, so a new code cannot be introduced on one
 * side and missed on the other (R-ARCH-007).
 *
 * ```jsonc
 * {
 *   "error": {
 *     "code": "EMAIL_TAKEN",        // stable, machine-readable
 *     "message": "Email taken",     // developer-facing, NEVER rendered raw
 *     "details": {},                // optional field-level errors
 *     "correlationId": "8f3a2b91"   // matches the server log line
 *   }
 * }
 * ```
 *
 * PRD §8.1 forbids showing internal identifiers or raw error text to users, so
 * `message` is for the developer reading a network tab and `code` is what the
 * client switches on to choose copy from `strings.ts`. The `correlationId` is
 * the one internal value a user may see, and only as "Ref: 8f3a2b91" next to a
 * generic message — it is what makes a support conversation tractable.
 */

export const ERROR_CODES = {
  // Auth — TRD §4.1
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  INVALID_REFRESH: 'INVALID_REFRESH',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_USED: 'TOKEN_USED',
  OAUTH_FAILED: 'OAUTH_FAILED',
  PASSWORD_REQUIRED: 'PASSWORD_REQUIRED',
  CONFIRMATION_MISMATCH: 'CONFIRMATION_MISMATCH',

  // Generic
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    correlationId: z.string().min(1),
    /**
     * Seconds until the caller may retry. Present only on 429, and the reason
     * the login screen can render a live countdown rather than a vague "try
     * again later" (FLOWS §4 branch 3c).
     */
    retryAfter: z.number().int().nonnegative().optional(),
  }),
})

export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>

/**
 * A short correlation id.
 *
 * Eight hex characters, not a uuid: this is read aloud in support tickets and
 * typed back by hand, and a 36-character uuid does not survive that. The
 * collision risk is irrelevant because it only ever has to be unique among the
 * log lines from roughly the same minute.
 */
export function newCorrelationId(): string {
  return Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0')
}
