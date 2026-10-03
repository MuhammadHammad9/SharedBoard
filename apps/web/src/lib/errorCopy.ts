import { ApiError } from './api.js'
import { errors } from './strings.js'

/**
 * PRD §8.2 "Generic server error": "Something went wrong on our end. We're
 * looking into it." + `Ref: {8-char id}`.
 *
 * The ref is the server's correlation id for the failed request (every error
 * envelope carries one), cut to 8 characters — enough to find the log line,
 * short enough to read out. Without one (a network failure never reached the
 * server) the message stands alone.
 */
export function serverErrorMessage(error?: unknown): string {
  const id = error instanceof ApiError ? error.correlationId : undefined
  return id
    ? `${errors.genericServerError} ${errors.genericServerErrorRef(id.slice(0, 8))}`
    : errors.genericServerError
}
