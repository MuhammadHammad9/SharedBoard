import type { Request, RequestHandler } from 'express'
import { ERROR_CODES } from '@coboard/shared'
import { verifyAccessToken } from '../../lib/jwt.js'
import { HttpError } from './errorHandler.js'
import type { Identity } from '../../lib/identity.js'

export type { Identity }

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
  /** Set by `identify` for a guest — FR-AUTH-006, decision D-1. */
  guestId?: string
}

export const GUEST_HEADER = 'x-coboard-guest'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function guestHeader(req: Request): string | null {
  const raw = req.headers[GUEST_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  return value && UUID.test(value) ? value.toLowerCase() : null
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

/**
 * Resolve a user (bearer token) or, failing that, a guest (guest header).
 *
 * A user token always wins: a signed-in person who also has a guest identity
 * in storage from an earlier visit is acting as themselves. Neither present is
 * a 401 — routes that guests may not use still call `assertAuthenticated`,
 * which rejects a guest the same way.
 */
export const identify: RequestHandler = (req, _res, next) => {
  const token = bearer(req)
  const userId = token ? verifyAccessToken(token) : null
  if (userId) {
    ;(req as AuthedRequest).userId = userId
    return next()
  }
  const guestId = guestHeader(req)
  if (guestId) {
    ;(req as AuthedRequest).guestId = guestId
    return next()
  }
  next(new HttpError(ERROR_CODES.UNAUTHORIZED, 'Missing or invalid access token', 401))
}

/** As `identify`, but an anonymous request is allowed through. */
export const identifyOptional: RequestHandler = (req, _res, next) => {
  const token = bearer(req)
  const userId = token ? verifyAccessToken(token) : null
  if (userId) (req as AuthedRequest).userId = userId
  else {
    const guestId = guestHeader(req)
    if (guestId) (req as AuthedRequest).guestId = guestId
  }
  next()
}

export function identityOf(req: Request): Identity | null {
  const { userId, guestId } = req as AuthedRequest
  if (userId) return { kind: 'user', userId }
  if (guestId) return { kind: 'guest', guestId }
  return null
}

/** As `identityOf`, after `identify` — throws rather than returning null. */
export function assertIdentified(req: Request): Identity {
  const identity = identityOf(req)
  if (!identity) {
    throw new HttpError(ERROR_CODES.UNAUTHORIZED, 'Route requires identify', 401)
  }
  return identity
}
