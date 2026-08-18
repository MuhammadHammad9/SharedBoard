import { Link } from 'react-router'
import { useAuthStore } from '../stores/authStore.js'
import { emptyStates } from '../lib/strings.js'

/**
 * S-07 Dashboard — PLACEHOLDER.
 *
 * Boards CRUD, the grid, search, sort and the card menu are all Phase 8
 * (FR-BOARD-001…009). What exists here is only what Phase 7 needs: somewhere
 * for a successful login to land, proving the session round-trips.
 *
 * The empty-state copy is the real string from PRD §8.3 rather than "TODO",
 * so replacing this screen is a matter of adding the grid around copy that is
 * already correct.
 */
export default function Dashboard() {
  const user = useAuthStore(s => s.user)

  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-5xl flex-col gap-6 px-4 py-12">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-primary">Your boards</h1>
        <Link
          to="/settings"
          className="text-sm font-medium text-accent hover:underline"
          data-testid="settings-link"
        >
          {user?.displayName ?? 'Settings'}
        </Link>
      </header>

      <div
        className="flex flex-col items-center gap-2 rounded-lg border border-border bg-app py-20"
        data-testid="dashboard-empty"
      >
        <p className="text-base font-medium text-primary">
          {emptyStates.dashboardNoBoards.headline}
        </p>
        <p className="text-sm text-muted">{emptyStates.dashboardNoBoards.body}</p>
      </div>
    </main>
  )
}
