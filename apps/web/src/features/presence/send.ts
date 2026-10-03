import {
  PRESENCE_HEAVY_SELECTION_THRESHOLD,
  PRESENCE_HEAVY_THROTTLE_MS,
  PRESENCE_THROTTLE_MS,
  type ClientMessage,
  type ObjectId,
} from '@coboard/shared'
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
  /** A live drag: the selection, offset from where it started (canvas units). */
  transform: (ids: readonly ObjectId[], dx: number, dy: number) => void
  /** The drag ended or was cancelled — clears the preview everywhere. */
  transformEnd: () => void
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

  /*
   * FLOWS E-07: 20 Hz normally, 10 Hz above 100 selected objects. A drag of
   * 500 objects puts 500 ids in every message, and halving the rate is what
   * keeps that inside the room's bandwidth. Two throttles rather than one
   * whose interval changes, so a selection crossing the threshold mid-drag
   * never shortens a window already running.
   */
  const transformAt = (ms: number) =>
    throttle((ids: readonly ObjectId[], dx: number, dy: number) => {
      send({ t: 'xform', ids: [...ids], dx: round1(dx), dy: round1(dy) })
    }, ms)
  const sendTransform = transformAt(intervalMs)
  const sendHeavyTransform = transformAt(
    intervalMs === PRESENCE_THROTTLE_MS ? PRESENCE_HEAVY_THROTTLE_MS : intervalMs * 2,
  )

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

    transform: (ids, dx, dy) =>
      ids.length > PRESENCE_HEAVY_SELECTION_THRESHOLD
        ? sendHeavyTransform(ids, dx, dy)
        : sendTransform(ids, dx, dy),

    transformEnd: () => {
      // Flushed, like `strokeDone`: a lost end leaves a ghost outline behind.
      sendTransform.cancel()
      sendHeavyTransform.cancel()
      send({ t: 'xform', ids: [], dx: 0, dy: 0 })
    },

    dispose: () => {
      sendTransform.cancel()
      sendHeavyTransform.cancel()
      sendCursor.cancel()
      sendSelection.cancel()
      sendStroke.cancel()
      sentUpTo.clear()
    },
  }
}
