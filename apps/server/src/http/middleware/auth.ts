import type { Request, RequestHandler } from 'express'
import { ERROR_CODES } from '@coboard/shared'
import { verifyAccessToken } from '../../lib/jwt.js'
import { HttpError } from './errorHandler.js'

/**
 * Bearer-token authentication — R-SEC-001, R-SEC-002.
 *
 * The access token arrives in the Authorization header, never in a cookie.
 * That is what makes the API immune to CSRF on authenticated routes: a
 * cross-site form post cannot set a header, and the only cookie we do use —
 * the refresh token — is SameSite=Lax and reaches exactly one endpoint.
 */

/** Set by `requireAuth`. Absent means the request is anonymous. */
export interface AuthedRequest extends Request {
  userId?: string
}

function bearer(req: Request): string | null {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token.length > 0 ? token : null
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  const token = bearer(req)
  const userId = token ? verifyAccessToken(token) : null
  if (!userId) {
    return next(
      new HttpError(ERROR_CODES.UNAUTHORIZED, 'Missing or invalid access token', 401),
    )
  }
  ;(req as AuthedRequest).userId = userId
  next()
}

/** Populates `userId` when a token is present, but never rejects. */
export const optionalAuth: RequestHandler = (req, _res, next) => {
  const token = bearer(req)
  const userId = token ? verifyAccessToken(token) : null
  if (userId) (req as AuthedRequest).userId = userId
  next()
}

/**
 * Narrow `userId` to a string after `requireAuth`.
 *
 * Exists so handlers never write `req.userId!`. A non-null assertion is a
 * silent promise that the middleware ran; this throws loudly if it did not,
 * which is the difference between a 500 with a stack trace and a route
 * quietly operating on `undefined` as a user id.
 */
export function assertAuthenticated(req: Request): string {
  const { userId } = req as AuthedRequest
  if (!userId) {
    throw new HttpError(ERROR_CODES.UNAUTHORIZED, 'Route requires requireAuth', 401)
  }
  return userId
}
