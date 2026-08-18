import type { RequestHandler } from 'express'
import type { ZodSchema } from 'zod'

/**
 * Parse and REPLACE the body with the validated result — R-SEC-003.
 *
 * Replacing rather than merely checking is the point: downstream handlers then
 * work with the parsed value, so a Zod `.transform()` such as trimming a
 * display name actually takes effect instead of being validated and discarded.
 *
 * Rejection is thrown, not coerced. The error handler turns a ZodError into a
 * 422 with field-level details.
 */
export const validateBody =
  (schema: ZodSchema): RequestHandler =>
  (req, _res, next) => {
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) return next(parsed.error)
    req.body = parsed.data
    next()
  }

export const validateQuery =
  (schema: ZodSchema): RequestHandler =>
  (req, _res, next) => {
    const parsed = schema.safeParse(req.query)
    if (!parsed.success) return next(parsed.error)
    // req.query is a getter on Express 5; assign through defineProperty so the
    // same helper keeps working if the app is upgraded.
    Object.defineProperty(req, 'validatedQuery', { value: parsed.data, writable: true })
    next()
  }

export const validatedQuery = <T>(req: unknown): T =>
  (req as { validatedQuery: T }).validatedQuery
