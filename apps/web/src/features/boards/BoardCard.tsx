import { useState } from 'react'
import { useNavigate } from 'react-router'
import { DotsThreeVertical } from '@phosphor-icons/react'
import { Dropdown } from '../../components/ui/Dropdown.js'
import { EmptyBoardGraphic } from './EmptyBoardGraphic.js'
import { RenameInline } from './RenameInline.js'
import { absoluteTime, relativeTime } from '../../lib/relativeTime.js'
import { actions, dashboard } from '../../lib/strings.js'
import { useToast } from '../../components/ui/Toast.js'
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
  /** Owner only — opens S-12 for this board (FLOWS §6.4). */
  onShare?: () => void
  onLeave?: () => void
}

/** The board's own URL — what "Copy link" copies and "Open in new tab" opens (D-35). */
export const boardUrl = (id: string): string => `${window.location.origin}/board/${id}`

export function BoardCard({
  board,
  currentUserId,
  onRename,
  onTrash,
  onDuplicate,
  onShare,
  onLeave,
}: BoardCardProps) {
  const navigate = useNavigate()
  const toast = useToast()
  const [renaming, setRenaming] = useState(false)
  const isOwner = board.ownerId === currentUserId

  const open = () => navigate(`/board/${board.id}`)

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(boardUrl(board.id))
      toast.show({ message: dashboard.card.linkCopied })
    } catch {
      toast.show({ message: dashboard.card.linkCopyFailed, variant: 'danger' })
    }
  }

  /*
   * FLOWS §6.4, in its order. Rename, Share and Move-to-trash are owner-only;
   * Leave board is non-owner-only. The server enforces all of it (R-SEC-001);
   * hiding the items is UX, so that a viewer is not offered an action that
   * will 403. Star / Unstar is FR-BOARD-008 [P2] and is not built (D-34).
   */
  const items = [
    { label: dashboard.card.open, onSelect: open, testId: 'card-open' },
    {
      label: dashboard.card.openInNewTab,
      // `noopener`: the new tab gets no handle back to this one.
      onSelect: () => void window.open(boardUrl(board.id), '_blank', 'noopener'),
      testId: 'card-open-new-tab',
    },
    ...(isOwner
      ? [
          {
            label: dashboard.card.rename,
            onSelect: () => setRenaming(true),
            testId: 'card-rename',
          },
        ]
      : []),
    {
      label: dashboard.card.duplicate,
      onSelect: onDuplicate,
      testId: 'card-duplicate',
    },
    ...(isOwner && onShare
      ? [{ label: dashboard.card.share, onSelect: onShare, testId: 'card-share' }]
      : []),
    {
      label: dashboard.card.copyLink,
      onSelect: () => void copyLink(),
      testId: 'card-copy-link',
    },
    {
      label: dashboard.card.exportPng,
      // D-35: rendering needs the board's objects and the renderer, which
      // live in the board chunk. The board opens S-14 itself once loaded.
      onSelect: () => navigate(`/board/${board.id}?export=1`),
      testId: 'card-export',
    },
    ...(isOwner
      ? [
          {
            label: actions.moveToTrash,
            onSelect: onTrash,
            danger: true,
            testId: 'card-trash',
          },
        ]
      : onLeave
        ? [
            {
              label: dashboard.card.leave,
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
          // FLOWS §6.2 / FR-BOARD-003: no thumbnail yet, or an empty board.
          <EmptyBoardGraphic />
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
            <time
              dateTime={board.lastActivityAt}
              title={absoluteTime(board.lastActivityAt)}
            >
              {relativeTime(board.lastActivityAt)}
            </time>
            {!isOwner ? <span> · {board.ownerName}</span> : null}
          </p>

          <MemberAvatars board={board} />
        </div>

        {/*
         * Visible on hover, on focus-within, and always on touch — where there
         * is no hover to reveal it. `group-focus-within` is what keeps it
         * reachable by keyboard.
         */}
        <div className="opacity-100 transition-opacity duration-fast sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          <Dropdown
            label={dashboard.card.actionsFor(board.name)}
            items={items}
            trigger={props => (
              <button
                {...props}
                type="button"
                data-testid="card-menu"
                aria-label={dashboard.card.actionsFor(board.name)}
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

/**
 * The avatar row — FLOWS §6.2 "(A)(B)(C) +2", FR-BOARD-002: the owner, then
 * up to four collaborators, then "+N" for the rest. Static: no hover motion,
 * nothing that moves the card's layout (A-70).
 */
function MemberAvatars({ board }: { board: BoardSummary }) {
  const overflow = Math.max(0, board.memberCount - board.members.length)
  const people = [
    {
      id: `owner-${board.ownerId}`,
      displayName: board.ownerName,
      avatarUrl: board.ownerAvatarUrl,
    },
    ...board.members,
  ]
  return (
    <ul
      className="mt-2 flex items-center"
      aria-label={dashboard.card.membersLabel}
      data-testid="card-avatars"
    >
      {people.map((person, i) => (
        <li
          key={person.id}
          className={i > 0 ? '-ml-2' : ''}
          title={person.displayName}
          data-testid="card-avatar"
        >
          <Avatar name={person.displayName} url={person.avatarUrl} />
        </li>
      ))}
      {overflow > 0 ? (
        <li
          className="-ml-2 flex h-6 min-w-6 items-center justify-center rounded-full border-2 border-app bg-subtle px-1 text-[10px] font-semibold text-primary"
          aria-label={dashboard.card.moreMembersLabel(overflow)}
          data-testid="card-avatar-overflow"
        >
          {dashboard.card.moreMembers(overflow)}
        </li>
      ) : null}
    </ul>
  )
}

function Avatar({ name, url }: { name: string; url: string | null }) {
  // A picture that fails to load (a Google avatar the CSP's img-src does not
  // list, a deleted object) falls back to initials rather than a broken icon.
  const [failed, setFailed] = useState(false)
  // The name is the accessible label; the picture or initials are decoration.
  return (
    <span
      className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full border-2 border-app bg-subtle text-[10px] font-semibold text-primary"
      role="img"
      aria-label={name}
    >
      {url && !failed ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        initials(name)
      )}
    </span>
  )
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  const first = parts[0]?.[0] ?? ''
  const second = parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : ''
  return (first + second).toUpperCase() || '?'
}
