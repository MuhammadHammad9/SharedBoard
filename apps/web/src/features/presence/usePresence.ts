import { useSyncExternalStore } from 'react'
import type { ObjectId, ServerMessage } from '@coboard/shared'
import { boardStore } from '../../stores/boardStore.js'
import { selectionBounds } from '../canvas/geometry/bounds.js'
import type { PresenceView } from './drawPresence.js'
import { presenceStore } from './presenceStore.js'
import { truncateName } from './drawPresence.js'

/** The pen default. See the note at the call site for why it is not on the wire. */
const PREVIEW_STROKE_WIDTH = 3

/**
 * The presence wiring — FLOWS §9.1, §9.2.
 *
 * Three seams, kept apart on purpose:
 *
 *   `handlePresenceMessage`  socket → store        (called by the session)
 *   `buildPresenceView`      store → renderer      (called once per frame)
 *   `useRoster`              store → React         (roster changes only)
 *
 * The middle one is where the performance rule lives: the renderer PULLS a
 * view once per painted frame rather than being pushed at 20 Hz per user
 * (R-ARCH-003). Ten people moving cursors produce 200 store writes a second
 * and 60 reads.
 */

/** Route a server message into the store. Returns true if it was presence. */
export function handlePresenceMessage(message: ServerMessage): boolean {
  switch (message.t) {
    case 'join_ack':
      presenceStore.setOwnSession(message.sessionId)
      presenceStore.replaceRoster(message.users)
      return true

    case 'presence_join':
      presenceStore.join(message.user)
      return true

    case 'presence_leave':
      presenceStore.leave(message.sessionId)
      return true

    case 'cursor':
      presenceStore.moveCursor(message.sessionId, message.x, message.y)
      return true

    case 'sel':
      presenceStore.setSelection(message.sessionId, message.ids as ObjectId[])
      return true

    case 'stroke':
      presenceStore.appendStroke(
        message.sessionId,
        message.id,
        message.pts,
        message.done,
      )
      return true

    default:
      return false
  }
}

/**
 * Build the renderer's view of presence.
 *
 * Called from the render loop, so it must be cheap and allocation-light. It
 * returns `null` when there is nothing to draw, which lets the renderer skip
 * the whole presence pass on a single-player board — the common case.
 */
export function buildPresenceView(): PresenceView | null {
  const cursors = presenceStore.allCursors()
  const selections = presenceStore.allSelections()
  const strokes = presenceStore.allStrokes()
  if (cursors.length === 0 && selections.length === 0 && strokes.length === 0) return null

  const { objects } = boardStore.getState()

  return {
    cursors: cursors.flatMap(cursor => {
      const user = presenceStore.user(cursor.sessionId)
      // A cursor whose roster entry has not arrived yet is skipped rather than
      // drawn nameless: an unlabelled pointer is exactly the colour-only
      // identification R-A11Y-007 forbids.
      if (!user) return []
      return [{ ...cursor, name: truncateName(user.name), colour: user.colour }]
    }),

    selections: selections.flatMap(({ sessionId, ids }) => {
      const user = presenceStore.user(sessionId)
      if (!user) return []
      const selected = ids.flatMap(id => {
        const object = objects.get(id)
        return object ? [object] : []
      })
      const box = selectionBounds(selected)
      return box ? [{ box, colour: user.colour, name: truncateName(user.name) }] : []
    }),

    strokes: strokes.flatMap(stroke => {
      const user = presenceStore.user(stroke.sessionId)
      if (!user) return []
      return [
        {
          ...stroke,
          colour: user.colour,
          /*
           * The sender's pen width is not on the wire — the `stroke` message
           * carries points and nothing else, deliberately, because it fires
           * 20 times a second. The project default is close enough for a
           * preview that the real object replaces a moment later.
           */
          strokeWidth: PREVIEW_STROKE_WIDTH,
        },
      ]
    }),
  }
}

/**
 * The roster, for React.
 *
 * Subscribes to ROSTER changes only — someone joining or leaving, a few times
 * an hour. Cursor movement does not bump the version and so does not re-render
 * the header (R-ARCH-003).
 */
export function useRoster() {
  return useSyncExternalStore(
    presenceStore.subscribe,
    () => presenceStore.snapshot(),
    () => presenceStore.snapshot(),
  )
}
