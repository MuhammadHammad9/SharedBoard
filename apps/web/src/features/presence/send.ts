import { PRESENCE_THROTTLE_MS, type ClientMessage, type ObjectId } from '@coboard/shared'
import { throttle } from '../../lib/throttle.js'

/**
 * The presence SEND side — TRD §10.3.
 *
 * Everything here is throttled to 20 Hz and dropped when the socket is down.
 * That last part is the rule, not a fallback: presence is never queued
 * (R-SYNC-001). A cursor position from eight seconds ago has no value, and an
 * outbox full of them is an outbox that has stopped protecting the ops it
 * exists for.
 */

export type PresenceSender = (message: ClientMessage) => boolean

export interface PresenceEmitter {
  cursor: (x: number, y: number) => void
  selection: (ids: readonly ObjectId[]) => void
  /** `points` is the FULL array; the delta is computed here. */
  strokeProgress: (strokeId: string, points: readonly number[]) => void
  strokeDone: (strokeId: string) => void
  dispose: () => void
}

/** One decimal place. A cursor is a pointer, not a measurement. */
const round1 = (n: number) => Math.round(n * 10) / 10

export function createPresenceEmitter(
  send: PresenceSender,
  intervalMs = PRESENCE_THROTTLE_MS,
): PresenceEmitter {
  let lastX = Number.NaN
  let lastY = Number.NaN

  /*
   * CHANGE DETECTION BEFORE THE THROTTLE, not after.
   *
   * A pointer resting still fires no `pointermove`, but a pointer being held
   * during a drag fires constantly at the same coordinates. Without this the
   * room receives 20 identical messages a second from someone who is not
   * moving.
   */
  const sendCursor = throttle((x: number, y: number) => {
    if (x === lastX && y === lastY) return
    lastX = x
    lastY = y
    send({ t: 'cursor', x, y })
  }, intervalMs)

  const sendSelection = throttle((ids: readonly ObjectId[]) => {
    send({ t: 'sel', ids: [...ids] })
  }, intervalMs)

  /**
   * How many numbers of the current stroke have been sent.
   *
   * Keyed by stroke id so a second stroke started before the first's `done`
   * arrives does not inherit the first's offset and send a garbled delta.
   */
  const sentUpTo = new Map<string, number>()

  const sendStroke = throttle((strokeId: string, points: readonly number[]) => {
    const from = sentUpTo.get(strokeId) ?? 0
    if (points.length <= from) return
    const delta = points.slice(from)
    sentUpTo.set(strokeId, points.length)
    send({ t: 'stroke', id: strokeId, pts: delta, done: false })
  }, intervalMs)

  return {
    cursor: (x, y) => sendCursor(round1(x), round1(y)),
    selection: ids => sendSelection(ids),
    strokeProgress: (strokeId, points) => sendStroke(strokeId, points),

    strokeDone: strokeId => {
      /*
       * Flushed, not throttled. `done` is the message that clears everyone
       * else's preview, and losing it to a throttle window leaves a ghost
       * stroke on their screen until the sweep collects it a minute later.
       */
      sendStroke.flush()
      sentUpTo.delete(strokeId)
      send({ t: 'stroke', id: strokeId, pts: [], done: true })
    },

    dispose: () => {
      sendCursor.cancel()
      sendSelection.cancel()
      sendStroke.cancel()
      sentUpTo.clear()
    },
  }
}
