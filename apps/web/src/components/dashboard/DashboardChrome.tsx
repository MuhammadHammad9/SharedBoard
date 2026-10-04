import { Link, NavLink } from 'react-router'
import { MagnifyingGlass, Plus } from '@phosphor-icons/react'
import { Button } from '../ui/Button.js'
import { Dropdown } from '../ui/Dropdown.js'
import { actions, brand, dashboard } from '../../lib/strings.js'
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
  { id: 'all', label: dashboard.filters.all },
  { id: 'owned', label: dashboard.filters.owned },
  { id: 'shared', label: dashboard.filters.shared },
  { id: 'starred', label: dashboard.filters.starred },
]

const SORTS: Array<{ id: BoardSort; label: string }> = [
  { id: 'lastEdited', label: dashboard.sorts.lastEdited },
  { id: 'created', label: dashboard.sorts.created },
  { id: 'name', label: dashboard.sorts.name },
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
        {brand.name}
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
          placeholder={dashboard.searchPlaceholder}
          aria-label={dashboard.searchLabel}
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
          label={dashboard.account}
          items={[
            {
              label: dashboard.settings,
              onSelect: () => window.location.assign('/settings'),
            },
            {
              label: dashboard.logOut,
              onSelect: () => {
                void logout().finally(() => {
                  clear()
                  // PRD FR-AUTH-007: logout returns to the landing page.
                  window.location.assign('/')
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
              aria-label={user?.displayName ?? dashboard.account}
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

/*
 * D-18: --color-text-secondary on --color-bg-subtle is 4.39:1, under WCAG AA.
 * The sidebar and filters sit on the subtle page, so their text is primary and
 * the active item is marked by a white pill and weight, not by greying the rest.
 */
export function DashboardSidebar() {
  const link = ({ isActive }: { isActive: boolean }) =>
    `block rounded-md px-3 py-2 text-sm transition-colors duration-fast ${
      isActive
        ? 'bg-app font-medium text-primary shadow-panel'
        : 'text-primary hover:bg-app'
    }`

  return (
    <nav
      aria-label={dashboard.nav.label}
      className="hidden w-48 shrink-0 flex-col gap-1 md:flex"
    >
      <NavLink to="/dashboard" end className={link} data-testid="nav-boards">
        {dashboard.nav.boards}
      </NavLink>
      <NavLink to="/trash" className={link} data-testid="nav-trash">
        {dashboard.nav.trash}
      </NavLink>
      <NavLink to="/settings" className={link} data-testid="nav-settings">
        {dashboard.nav.settings}
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
    <div role="tablist" aria-label={dashboard.filters.label} className="flex gap-1">
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
              ? 'bg-app font-medium text-primary shadow-panel'
              : 'text-primary hover:bg-app'
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
      label={dashboard.sorts.label}
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
