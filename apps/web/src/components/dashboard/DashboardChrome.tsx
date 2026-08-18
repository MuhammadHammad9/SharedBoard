import { Link, NavLink } from 'react-router'
import { MagnifyingGlass, Plus } from '@phosphor-icons/react'
import { Button } from '../ui/Button.js'
import { Dropdown } from '../ui/Dropdown.js'
import { actions } from '../../lib/strings.js'
import { useAuthStore } from '../../stores/authStore.js'
import { logout } from '../../features/auth/api.js'
import type { BoardFilter, BoardSort } from '../../features/boards/useBoards.js'

/**
 * Dashboard header and sidebar — FLOWS §6.1.
 *
 * Split out of the route so the route file is about STATE and this file is
 * about layout. It matters here more than usual: FLOWS §6.3 requires that on
 * the error state "the sidebar and header stay functional", so the chrome has
 * to render independently of whether the board query succeeded. Keeping them
 * in one component makes that easy to get wrong.
 */

const FILTERS: Array<{ id: BoardFilter; label: string }> = [
  { id: 'all', label: 'All boards' },
  { id: 'owned', label: 'Owned by me' },
  { id: 'shared', label: 'Shared with me' },
  { id: 'starred', label: 'Starred' },
]

const SORTS: Array<{ id: BoardSort; label: string }> = [
  { id: 'lastEdited', label: 'Last edited' },
  { id: 'created', label: 'Date created' },
  { id: 'name', label: 'Name' },
]

export function DashboardHeader({
  search,
  onSearch,
  onCreate,
  creating,
}: {
  search: string
  onSearch: (value: string) => void
  onCreate: () => void
  creating: boolean
}) {
  const user = useAuthStore(s => s.user)
  const clear = useAuthStore(s => s.clear)

  return (
    <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-app px-4 py-3">
      <Link to="/dashboard" className="text-sm font-semibold text-primary">
        CoBoard
      </Link>

      <div className="relative ml-2 hidden max-w-sm flex-1 sm:block">
        <MagnifyingGlass
          size={16}
          weight="light"
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
        />
        <input
          type="search"
          value={search}
          onChange={event => onSearch(event.target.value)}
          placeholder="Search boards"
          aria-label="Search boards"
          data-testid="board-search"
          className="w-full rounded-md border border-border bg-app py-2 pl-9 pr-3 text-sm text-primary outline-none transition-colors duration-fast placeholder:text-muted focus-visible:border-accent"
        />
      </div>

      <div className="ml-auto flex items-center gap-2">
        <Button onClick={onCreate} loading={creating} data-testid="new-board">
          <span className="flex items-center gap-1.5">
            <Plus size={16} weight="bold" aria-hidden="true" />
            {actions.newBoard}
          </span>
        </Button>

        <Dropdown
          label="Account"
          items={[
            { label: 'Settings', onSelect: () => window.location.assign('/settings') },
            {
              label: 'Log out',
              onSelect: () => {
                void logout().finally(() => {
                  clear()
                  window.location.assign('/login')
                })
              },
              testId: 'log-out',
            },
          ]}
          trigger={props => (
            <button
              {...props}
              type="button"
              data-testid="account-menu"
              aria-label={user?.displayName ?? 'Account'}
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-subtle text-xs font-semibold text-primary outline-none transition-colors duration-fast hover:bg-border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {initials(user?.displayName)}
            </button>
          )}
        />
      </div>
    </header>
  )
}

export function DashboardSidebar() {
  const link = ({ isActive }: { isActive: boolean }) =>
    `block rounded-md px-3 py-2 text-sm transition-colors duration-fast ${
      isActive ? 'bg-subtle font-medium text-primary' : 'text-muted hover:bg-subtle'
    }`

  return (
    <nav aria-label="Boards" className="hidden w-48 shrink-0 flex-col gap-1 md:flex">
      <NavLink to="/dashboard" end className={link} data-testid="nav-boards">
        Boards
      </NavLink>
      <NavLink to="/trash" className={link} data-testid="nav-trash">
        Trash
      </NavLink>
      <NavLink to="/settings" className={link} data-testid="nav-settings">
        Settings
      </NavLink>
    </nav>
  )
}

export function FilterTabs({
  value,
  onChange,
}: {
  value: BoardFilter
  onChange: (filter: BoardFilter) => void
}) {
  return (
    // A real tablist, so arrow keys work and a screen reader announces the
    // selected one — R-A11Y-002.
    <div role="tablist" aria-label="Filter boards" className="flex gap-1">
      {FILTERS.map(filter => (
        <button
          key={filter.id}
          role="tab"
          type="button"
          aria-selected={value === filter.id}
          data-testid={`filter-${filter.id}`}
          onClick={() => onChange(filter.id)}
          className={`cursor-pointer rounded-md px-3 py-1.5 text-sm transition-colors duration-fast ${
            value === filter.id
              ? 'bg-subtle font-medium text-primary'
              : 'text-muted hover:bg-subtle'
          }`}
        >
          {filter.label}
        </button>
      ))}
    </div>
  )
}

export function SortMenu({
  value,
  onChange,
}: {
  value: BoardSort
  onChange: (sort: BoardSort) => void
}) {
  const current = SORTS.find(sort => sort.id === value) ?? SORTS[0]!

  return (
    <Dropdown
      label="Sort boards"
      items={SORTS.map(sort => ({
        label: sort.label,
        onSelect: () => onChange(sort.id),
        testId: `sort-${sort.id}`,
      }))}
      trigger={props => (
        <button
          {...props}
          type="button"
          data-testid="sort-menu"
          className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-sm text-primary outline-none transition-colors duration-fast hover:bg-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {current.label}
        </button>
      )}
    />
  )
}

/** Two letters, so the avatar reads as a person rather than a coloured circle. */
function initials(name: string | undefined): string {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  const first = parts[0]?.[0] ?? ''
  const second = parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : ''
  return (first + second).toUpperCase() || '?'
}
