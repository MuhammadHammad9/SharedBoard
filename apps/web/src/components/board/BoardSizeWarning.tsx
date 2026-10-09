import { useState } from 'react'
import { OBJECT_COUNT_SOFT_WARNING } from '@coboard/shared'
import { useBoardStore } from '../../stores/boardStore.js'
import { actions, errors } from '../../lib/strings.js'

/**
 * "This board is getting large. Consider splitting it up." + Dismiss — the
 * PRD §8.2 "Board too large" row, at the PRD §7.2 soft warning of 10,000
 * objects (`OBJECT_COUNT_SOFT_WARNING`; the hard cap stays 50,000).
 *
 * R-ARCH-003: the subscription is ONE BOOLEAN — whether the count is over the
 * line — so the component renders when the board crosses it and never on the
 * thousands of object changes either side.
 *
 * Dismissed once per board for the life of the tab: a warning that returns on
 * every remount of the board route is nagging, and one that never returns
 * after a reload is a warning nobody will see again on a board that is still
 * too large. Not shown to a viewer, who cannot act on it.
 *
 * Zone: board chrome. No motion — it appears, and it goes.
 */

const dismissed = new Set<string>()

/** Pure, for the tests. */
export const isBoardLarge = (count: number): boolean => count >= OBJECT_COUNT_SOFT_WARNING

export function BoardSizeWarning({
  boardId,
  readOnly,
}: {
  boardId: string
  readOnly: boolean
}) {
  const large = useBoardStore(s => isBoardLarge(s.objects.size))
  const [hidden, setHidden] = useState(() => dismissed.has(boardId))

  if (!large || hidden || readOnly) return null

  return (
    <div
      role="status"
      data-testid="board-size-warning"
      className="pointer-events-auto absolute left-1/2 top-28 z-header flex max-w-[36rem] -translate-x-1/2 items-center gap-3 rounded-md border border-border bg-app px-4 py-2 text-sm text-primary shadow-panel"
    >
      <span>{errors.boardTooLarge}</span>
      <button
        type="button"
        onClick={() => {
          dismissed.add(boardId)
          setHidden(true)
        }}
        data-testid="board-size-dismiss"
        className="cursor-pointer whitespace-nowrap rounded-sm font-medium text-accent outline-none transition-transform duration-fast ease-out hover:underline active:scale-[0.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {actions.dismiss}
      </button>
    </div>
  )
}
