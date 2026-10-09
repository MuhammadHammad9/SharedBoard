import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { CaretLeft, DotsThree, Keyboard } from '@phosphor-icons/react'
import { RenameInline } from '../../features/boards/RenameInline.js'
import { useToast } from '../ui/Toast.js'
import { useRenameBoard } from '../../features/boards/useBoards.js'
import {
  actions,
  boardChrome,
  boards as boardStrings,
  demo as demoStrings,
  shortcuts,
} from '../../lib/strings.js'
import { Button } from '../ui/Button.js'
import { ShareModal } from '../../features/sharing/ShareModal.js'
import { ConnectionIndicator } from './ConnectionIndicator.js'
import { AvatarStack } from '../../features/presence/AvatarStack.js'
import type { ConnectionState, Role } from '@coboard/shared'
import { ExportModal } from '../../features/export/ExportModal.js'
import { openExport } from '../../features/export/exportStore.js'
import { openShortcuts } from './shortcutsStore.js'
import { Dropdown } from '../ui/Dropdown.js'
import { useBreakpoint } from '../../lib/breakpoints.js'
import { useHomeExit } from '../ui/FullScreenState.js'

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
  demo = false,
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
  /** `/demo`: no server, so no connection to report and no dashboard to go back to. */
  demo?: boolean
}) {
  const mobile = useBreakpoint() === 'mobile'
  const [params, setParams] = useSearchParams()
  const [editing, setEditing] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [displayName, setDisplayName] = useState(name)
  const rename = useRenameBoard()
  const toast = useToast()
  // FLOWS §1.2: back arrow → S-07 when signed in, → S-01 for a guest (and in
  // /demo, which has no dashboard either).
  const homeExit = useHomeExit()
  const exit = demo ? { to: '/', label: demoStrings.back } : homeExit

  useEffect(() => setDisplayName(name), [name])

  useEffect(() => {
    const naming = params.get('new') === '1'
    // D-35: the dashboard card's "Export as PNG" lands here with `?export=1`.
    // The header mounts only once the board's objects are loaded, so S-14
    // opens over a complete board, never an empty one.
    const exporting = params.get('export') === '1'
    if (!naming && !exporting) return
    if (naming) setEditing(true)
    if (exporting) openExport()
    const next = new URLSearchParams(params)
    next.delete('new')
    next.delete('export')
    // `replace`, so Back does not step through the naming state.
    setParams(next, { replace: true })
  }, [params, setParams])

  const canRename = role === 'OWNER'

  return (
    <header className="pointer-events-none absolute inset-x-0 top-0 z-header flex items-center gap-3 px-4 py-3">
      <Link
        to={exit.to}
        aria-label={exit.label}
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
      {!demo && (
        <ConnectionIndicator
          state={connection}
          attempt={attempt}
          pending={pending}
          {...(onRetry ? { onRetry } : {})}
        />
      )}

      {mobile ? (
        /* FLOWS §14.5: the 48 px mobile header keeps the name, presence and
           connection; everything else lives behind `⋯`. */
        <span className="pointer-events-auto">
          <Dropdown
            label={boardChrome.more}
            items={[
              {
                label: actions.exportLabel,
                onSelect: openExport,
                testId: 'export-button',
              },
              ...(role === 'OWNER'
                ? [
                    {
                      label: actions.share,
                      onSelect: () => setSharing(true),
                      testId: 'share-button',
                    },
                  ]
                : []),
            ]}
            trigger={props => (
              <button
                {...props}
                type="button"
                aria-label={boardChrome.more}
                data-testid="header-more"
                className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-md bg-app/90 text-primary shadow-panel outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                <DotsThree size={20} weight="bold" aria-hidden="true" />
              </button>
            )}
          />
        </span>
      ) : (
        <>
          {/* FR-EXPORT-001: anyone who can see the board can export it. */}
          <span className="pointer-events-auto">
            <Button variant="secondary" onClick={openExport} data-testid="export-button">
              {actions.exportLabel}
            </Button>
          </span>
          {/* S-15 — also on `?`, but a key nobody knows about needs a door. */}
          <span className="pointer-events-auto">
            <button
              type="button"
              onClick={openShortcuts}
              aria-label={shortcuts.open}
              aria-keyshortcuts="?"
              data-testid="shortcuts-button"
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted outline-none transition-colors duration-fast hover:bg-subtle hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              <Keyboard size={18} weight="light" aria-hidden="true" />
            </button>
          </span>
          {/* FR-SHARE-001: inviting is the owner's alone, so the button is too. */}
          {role === 'OWNER' && (
            <span className="pointer-events-auto">
              <Button onClick={() => setSharing(true)} data-testid="share-button">
                {actions.share}
              </Button>
            </span>
          )}
        </>
      )}
      <ExportModal boardName={displayName} getSize={windowSize} />
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
