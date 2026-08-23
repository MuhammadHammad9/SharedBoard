import type { PresenceUser } from '@coboard/shared'
import { Tooltip } from '../../components/ui/Tooltip.js'
import { useRoster } from './usePresence.js'

/**
 * Who else is here — `FR-RT-004`, FLOWS §9.1.
 *
 * Board chrome. `ui-ux-pro-max` + `emil-design-eng`, dials 4/2/6. No Framer
 * Motion — this renders inside the board chunk and the import check fails the
 * build if one appears (`R-SKILL-060`).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  E-01 — TWO TABS, ONE PERSON.                                            │
 * │                                                                          │
 * │  Each tab is an independent session with its own socket, so the roster   │
 * │  legitimately holds two entries for one human. Showing two identical     │
 * │  avatars would read as two colleagues rather than one distracted one, so │
 * │  the stack DEDUPES BY USER ID. Their cursors stay separate — there       │
 * │  really are two pointers, and hiding one would be the confusing choice.  │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * MOTION: an avatar entering fades and scales from 0.9 over 200 ms — an
 * occasional event, comfortably clear of the frequency gate. Never from
 * `scale(0)` (`R-MOTION-032`). Leaving is a 150 ms fade, faster than entry,
 * because by then the user has stopped caring (`R-MOTION-023`).
 */

/** Beyond this, the rest collapse into "+N". */
const MAX_VISIBLE = 5

export function AvatarStack() {
  const { users } = useRoster()
  const unique = dedupeByUser(users)

  if (unique.length === 0) return null

  const visible = unique.slice(0, MAX_VISIBLE)
  const overflow = unique.length - visible.length

  return (
    <div
      className="pointer-events-auto flex items-center"
      data-testid="avatar-stack"
      // A list, so a screen reader announces "3 items" rather than reading
      // three initials as a run-on word.
      role="list"
      aria-label={`${unique.length} other ${unique.length === 1 ? 'person' : 'people'} on this board`}
    >
      {visible.map((user, index) => (
        <div
          key={user.userId ?? user.sessionId}
          role="listitem"
          // Overlapped by a third, in roster order. The negative margin is on
          // every avatar but the first, so the stack reads left-to-right.
          className={index === 0 ? '' : '-ml-2'}
          style={{ zIndex: MAX_VISIBLE - index }}
        >
          <Tooltip label={user.name} shortcut={roleLabel(user.role)}>
            <button
              type="button"
              data-testid="avatar"
              data-user-name={user.name}
              // Focusable so the tooltip is reachable by keyboard — otherwise
              // the name is mouse-only and the colour is all a keyboard user
              // gets (R-A11Y-007).
              className="flex h-7 w-7 cursor-default items-center justify-center rounded-full border-2 bg-app text-[10px] font-semibold text-primary outline-none transition-transform duration-fast focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              style={{ borderColor: user.colour }}
            >
              {initials(user.name)}
            </button>
          </Tooltip>
        </div>
      ))}

      {overflow > 0 ? (
        <div role="listitem" className="-ml-2">
          <Tooltip label={unique.slice(MAX_VISIBLE).map(u => u.name).join(', ')}>
            <button
              type="button"
              data-testid="avatar-overflow"
              className="flex h-7 w-7 cursor-default items-center justify-center rounded-full border-2 border-border bg-subtle text-[10px] font-semibold text-muted outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              +{overflow}
            </button>
          </Tooltip>
        </div>
      ) : null}
    </div>
  )
}

/**
 * One entry per HUMAN — E-01.
 *
 * Guests have no `userId`, so they fall back to the session id: two guest tabs
 * genuinely are two anonymous participants as far as anyone can tell, and
 * merging them would be a guess.
 */
export function dedupeByUser(users: readonly PresenceUser[]): PresenceUser[] {
  const seen = new Map<string, PresenceUser>()
  for (const user of users) {
    const key = user.userId ?? `guest:${user.sessionId}`
    if (!seen.has(key)) seen.set(key, user)
  }
  return [...seen.values()]
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  const first = parts[0]?.[0] ?? ''
  const second = parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : ''
  return (first + second).toUpperCase() || '?'
}

const roleLabel = (role: string): string | undefined =>
  role === 'VIEWER' ? 'Viewing' : undefined
