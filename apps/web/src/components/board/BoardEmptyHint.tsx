import { useEffect, useState } from 'react'
import { ArrowLeft } from '@phosphor-icons/react'
import { emptyStates } from '../../lib/strings.js'
import { useBoardStore } from '../../stores/boardStore.js'

/**
 * "Pick a tool and start drawing" — PRD §8.3, the board's empty state.
 *
 * A faint, centred hint with an arrow towards the toolbar. It "fades out
 * PERMANENTLY after the first object is created": once anything has been
 * made it never comes back, even if the board is emptied again.
 *
 *   - across sessions: shown only while the board has never had an op
 *     (`seq` 0 at load), so a board that once held objects never shows it
 *   - within a session: latched off at the first object, from anyone
 *
 * Not for viewers — they cannot pick a tool. Never intercepts the pointer.
 * The fade is the one exit animation (opacity, 200 ms, --ease-out); see
 * index.css. It is a rare, once-per-board event, so it may animate at all.
 */
export function BoardEmptyHint({ neverEdited }: { neverEdited: boolean }) {
  const empty = useBoardStore(s => s.objects.size === 0)
  const readOnly = useBoardStore(s => s.readOnly)
  const [gone, setGone] = useState(!neverEdited)

  useEffect(() => {
    if (!empty) setGone(true)
  }, [empty])

  if (readOnly) return null
  return (
    <div
      aria-hidden={gone}
      data-board-hint
      data-gone={gone ? 'true' : 'false'}
      data-testid="board-empty-hint"
      className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center"
    >
      <p className="flex items-center gap-2 text-sm text-muted">
        <ArrowLeft size={16} weight="light" aria-hidden="true" />
        {emptyStates.boardNoObjects.hint}
      </p>
    </div>
  )
}
