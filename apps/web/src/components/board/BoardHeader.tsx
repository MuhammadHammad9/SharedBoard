import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { CaretLeft } from '@phosphor-icons/react'
import { RenameInline } from '../../features/boards/RenameInline.js'
import { useToast } from '../ui/Toast.js'
import { useRenameBoard } from '../../features/boards/useBoards.js'
import { actions, boardChrome, boards as boardStrings } from '../../lib/strings.js'
import { Button } from '../ui/Button.js'
import { ShareModal } from '../../features/sharing/ShareModal.js'
import { ConnectionIndicator } from './ConnectionIndicator.js'
import { AvatarStack } from '../../features/presence/AvatarStack.js'
import type { ConnectionState, Role } from '@coboard/shared'
import { ExportModal } from '../../features/export/ExportModal.js'
import { openExport } from '../../features/export/exportStore.js'

/** The canvas fills the window on the board route, so the window is the view. */
const windowSize = () => ({ width: window.innerWidth, height: window.innerHeight })

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
  attempt = 0,
  pending = 0,
  onRetry,
}: {
  boardId: string
  name: string
  role: Role
  connection: ConnectionState
  /** Reconnect attempt in flight — FR-RT-009. */
  attempt?: number
  /** Unsent changes — FR-RT-009. */
  pending?: number
  /** "Retry now". */
  onRetry?: () => void
}) {
  const [params, setParams] = useSearchParams()
  const [editing, setEditing] = useState(false)
  const [sharing, setSharing] = useState(false)
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
        aria-label={actions.backToDashboard}
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
            title={canRename ? boardChrome.renameBoard : displayName}
            className="block w-full truncate text-left text-sm font-medium text-primary outline-none disabled:cursor-default enabled:cursor-pointer focus-visible:underline"
          >
            {displayName}
          </button>
        )}
      </div>

      {/* FLOWS §9.4: while we cannot hear anyone, the faces we last saw go
          grey — they are a memory, not a live roster. */}
      <AvatarStack stale={connection === 'reconnecting' || connection === 'offline'} />
      <ConnectionIndicator
        state={connection}
        attempt={attempt}
        pending={pending}
        {...(onRetry ? { onRetry } : {})}
      />

      {/* FR-EXPORT-001: anyone who can see the board can export it. */}
      <span className="pointer-events-auto">
        <Button variant="secondary" onClick={openExport} data-testid="export-button">
          {actions.exportLabel}
        </Button>
      </span>
      <ExportModal boardName={displayName} getSize={windowSize} />

      {/* FR-SHARE-001: inviting is the owner's alone, so the button is too. */}
      {role === 'OWNER' && (
        <span className="pointer-events-auto">
          <Button onClick={() => setSharing(true)} data-testid="share-button">
            {actions.share}
          </Button>
        </span>
      )}
      {role === 'OWNER' && (
        <ShareModal
          open={sharing}
          onClose={() => setSharing(false)}
          boardId={boardId}
          boardName={displayName}
        />
      )}
    </header>
  )
}
