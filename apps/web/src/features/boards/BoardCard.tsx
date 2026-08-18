import { useState } from 'react'
import { useNavigate } from 'react-router'
import { DotsThreeVertical, Image as ImageIcon } from '@phosphor-icons/react'
import { Dropdown } from '../../components/ui/Dropdown.js'
import { RenameInline } from './RenameInline.js'
import { absoluteTime, relativeTime } from '../../lib/relativeTime.js'
import { actions } from '../../lib/strings.js'
import type { BoardSummary } from './api.js'

/**
 * A board card — FLOWS §6.2, §6.4.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  HOVER MUST NOT SCALE — R-UI-021, anti-pattern A-70.                     │
 * │                                                                          │
 * │  A card that grows under the cursor shifts its neighbours, so moving the │
 * │  pointer across a grid makes the whole grid twitch. Shadow and border    │
 * │  colour only, 150 ms, and both are properties that do not affect layout. │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * The `⋮` menu appears on hover AND on focus. Hover-only would make it
 * unreachable by keyboard, which is the most common way a card menu ships
 * broken — the card is a link, so a keyboard user tabs to it and finds no
 * actions at all.
 *
 * The whole card navigates, but it is not wrapped in an `<a>`: a menu button
 * and a rename input inside an anchor is invalid HTML and the nested click
 * targets fight each other. Instead the card is a `<div>` with an inner
 * heading button carrying the accessible name, and the surface delegates.
 */

export interface BoardCardProps {
  board: BoardSummary
  currentUserId: string | undefined
  onRename: (name: string) => void
  onTrash: () => void
  onDuplicate: () => void
  onLeave?: () => void
}

export function BoardCard({
  board,
  currentUserId,
  onRename,
  onTrash,
  onDuplicate,
  onLeave,
}: BoardCardProps) {
  const navigate = useNavigate()
  const [renaming, setRenaming] = useState(false)
  const isOwner = board.ownerId === currentUserId

  const open = () => navigate(`/board/${board.id}`)

  /*
   * FLOWS §6.4: Rename, Share and Move-to-trash are owner-only; Leave board is
   * non-owner-only. The server enforces all of it (R-SEC-001); hiding the
   * items is UX, so that a viewer is not offered an action that will 403.
   */
  const items = isOwner
    ? [
        { label: 'Rename', onSelect: () => setRenaming(true), testId: 'card-rename' },
        { label: 'Duplicate', onSelect: onDuplicate, testId: 'card-duplicate' },
        {
          label: actions.moveToTrash,
          onSelect: onTrash,
          danger: true,
          testId: 'card-trash',
        },
      ]
    : [
        { label: 'Duplicate', onSelect: onDuplicate, testId: 'card-duplicate' },
        ...(onLeave
          ? [
              {
                label: 'Leave board',
                onSelect: onLeave,
                danger: true,
                testId: 'card-leave',
              },
            ]
          : []),
      ]

  return (
    <div
      data-testid="board-card"
      data-board-id={board.id}
      className="group relative flex cursor-pointer flex-col overflow-hidden rounded-lg border border-border bg-app transition-[box-shadow,border-color] duration-150 ease-standard hover:border-muted/40 hover:shadow-panel"
      onClick={open}
    >
      <div className="flex aspect-[16/10] w-full items-center justify-center bg-subtle">
        {board.thumbnailUrl ? (
          <img
            src={board.thumbnailUrl}
            alt=""
            // Lazy, and never a layout-shift source: the aspect ratio is on the
            // container, so the box is the right size before the image lands.
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          /*
           * The empty-board placeholder — FLOWS §6.2. Thumbnails need object
           * storage, which is Phase 13, so today every card shows this. It is
           * a real specified state rather than a stand-in.
           */
          <ImageIcon
            size={28}
            weight="light"
            aria-hidden="true"
            className="text-muted/50"
            data-testid="thumb-placeholder"
          />
        )}
      </div>

      <div className="flex items-start gap-2 p-3">
        <div className="min-w-0 flex-1">
          {renaming ? (
            <RenameInline
              value={board.name}
              onCommit={name => {
                setRenaming(false)
                onRename(name)
              }}
              onCancel={() => setRenaming(false)}
            />
          ) : (
            <button
              type="button"
              onClick={event => {
                event.stopPropagation()
                open()
              }}
              // `truncate` and not a wrap: two-line names would make the cards
              // different heights and the grid ragged.
              className="block w-full cursor-pointer truncate text-left text-sm font-medium text-primary outline-none focus-visible:underline"
            >
              {board.name}
            </button>
          )}

          <p className="mt-1 truncate text-xs text-muted">
            <time dateTime={board.lastActivityAt} title={absoluteTime(board.lastActivityAt)}>
              {relativeTime(board.lastActivityAt)}
            </time>
            {!isOwner ? <span> · {board.ownerName}</span> : null}
          </p>
        </div>

        {/*
         * Visible on hover, on focus-within, and always on touch — where there
         * is no hover to reveal it. `group-focus-within` is what keeps it
         * reachable by keyboard.
         */}
        <div className="opacity-100 transition-opacity duration-fast sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          <Dropdown
            label={`Actions for ${board.name}`}
            items={items}
            trigger={props => (
              <button
                {...props}
                type="button"
                data-testid="card-menu"
                aria-label={`Actions for ${board.name}`}
                className="cursor-pointer rounded-sm p-1 text-muted outline-none transition-colors duration-fast hover:bg-subtle hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <DotsThreeVertical size={18} weight="bold" aria-hidden="true" />
              </button>
            )}
          />
        </div>
      </div>
    </div>
  )
}
