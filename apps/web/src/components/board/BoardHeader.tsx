import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { CaretLeft } from '@phosphor-icons/react'
import { RenameInline } from '../../features/boards/RenameInline.js'
import { useToast } from '../ui/Toast.js'
import { useRenameBoard } from '../../features/boards/useBoards.js'
import { boards as boardStrings } from '../../lib/strings.js'
import { ConnectionIndicator } from './ConnectionIndicator.js'
import type { ConnectionState, Role } from '@coboard/shared'

/**
 * S-10 board header — the title, and the way back out.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  `?new=1` OPENS THE TITLE IN EDIT MODE — FLOWS §6.5.                     │
 * │                                                                          │
 * │  "Create board" deliberately shows no naming dialog: the fast path is a  │
 * │  click and then drawing. But a workspace of forty "Untitled board" cards │
 * │  is the cost of that, so the compromise is that arriving from Create     │
 * │  puts the caret in the title, text selected, ready to type — and ignoring│
 * │  it costs nothing, because the board is already open behind it.          │
 * │                                                                          │
 * │  The flag is stripped from the URL immediately, so a refresh does not    │
 * │  reopen the editor over a board the user has been working on for an hour.│
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Zone: board chrome. `ui-ux-pro-max` + `emil-design-eng`, dials 4/2/6. NO
 * Framer Motion — this file is inside the board chunk, and the import check
 * fails the build if one appears (`R-SKILL-060`, `R-PERF-021`). Nothing here
 * animates: a header the user looks at for an hour is not the place for it.
 */
export function BoardHeader({
  boardId,
  name,
  role,
  connection,
}: {
  boardId: string
  name: string
  role: Role
  connection: ConnectionState
}) {
  const [params, setParams] = useSearchParams()
  const [editing, setEditing] = useState(false)
  const [displayName, setDisplayName] = useState(name)
  const rename = useRenameBoard()
  const toast = useToast()

  useEffect(() => setDisplayName(name), [name])

  useEffect(() => {
    if (params.get('new') !== '1') return
    setEditing(true)
    const next = new URLSearchParams(params)
    next.delete('new')
    // `replace`, so Back does not step through the naming state.
    setParams(next, { replace: true })
  }, [params, setParams])

  const canRename = role === 'OWNER'

  return (
    <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center gap-3 px-4 py-3">
      <Link
        to="/dashboard"
        aria-label="Back to dashboard"
        data-testid="board-back"
        className="pointer-events-auto flex items-center gap-1 rounded-md bg-app/90 px-2 py-1.5 text-sm text-muted shadow-panel outline-none transition-colors duration-fast hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <CaretLeft size={16} weight="bold" aria-hidden="true" />
      </Link>

      <div className="pointer-events-auto min-w-0 max-w-xs flex-1 rounded-md bg-app/90 px-2 py-1 shadow-panel">
        {editing && canRename ? (
          <RenameInline
            value={displayName}
            testId="board-title-input"
            onCommit={next => {
              setEditing(false)
              // Optimistic locally as well as in the query cache, so the header
              // shows the new name before the round trip completes.
              setDisplayName(next)
              rename.mutate(
                { id: boardId, name: next },
                {
                  onError: () => {
                    setDisplayName(name)
                    toast.show({ message: boardStrings.renameFailed, variant: 'danger' })
                  },
                },
              )
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <button
            type="button"
            data-testid="board-title"
            disabled={!canRename}
            onClick={() => canRename && setEditing(true)}
            title={canRename ? 'Rename board' : displayName}
            className="block w-full truncate text-left text-sm font-medium text-primary outline-none disabled:cursor-default enabled:cursor-pointer focus-visible:underline"
          >
            {displayName}
          </button>
        )}
      </div>

      <ConnectionIndicator state={connection} />

      {role === 'VIEWER' ? (
        <span
          data-testid="viewer-badge"
          className="pointer-events-auto rounded-md bg-app/90 px-2 py-1 text-xs font-medium text-muted shadow-panel"
        >
          View only
        </span>
      ) : null}
    </header>
  )
}
