import type { Logger } from './logger.js'
import { opsRejected } from './metrics.js'

/**
 * One op refused — TRD §15.4: "Log every op rejection with the code, board,
 * actor, and correlation ID. A spike in rejections is the earliest signal that
 * something is wrong with permissions or validation."
 *
 * Both write paths call this, so the log line and the `op_rejected` counter
 * cannot drift apart. Warn level: a rejection is the system working, but a
 * rate of them is a signal someone should look at.
 *
 * `log` is the caller's child logger. The socket path's already binds
 * `sessionId`, `boardId` and `actor`, so it passes only what varies per op;
 * the REST path binds only `requestId`, so it passes board and actor here.
 * Passing a field the child already binds would write the key twice.
 */
export interface OpRejection {
  transport: 'ws' | 'rest'
  code: string
  opId: string
  /** `<sessionId>:<opId>` on a socket; the request id over REST. */
  correlationId: string
  boardId?: string
  actor?: string
  reason?: string
}

export function recordOpRejection(log: Logger, rejection: OpRejection): void {
  opsRejected.inc({ transport: rejection.transport, code: rejection.code })
  log.warn(rejection, 'op rejected')
}
