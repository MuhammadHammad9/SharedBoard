import { lazy, Suspense, type ReactNode } from 'react'
import { BoardCardSkeleton } from '../../components/ui/Skeleton.js'

/**
 * The grid, and the one place in the product where Framer Motion is worth its
 * bundle cost — `R-SKILL-060`, conflict `C-4`.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  It is LAZY, and that is load-bearing rather than tidy.                  │
 * │                                                                          │
 * │  Framer Motion is ~40 KB. Static-importing it here would put it in the   │
 * │  shared chunk, and from there into the board route, where it competes    │
 * │  with the render loop for the main thread the canvas needs (`C-3`).      │
 * │  `pnpm check:board-chunk` fails the build if it ever gets there, so this │
 * │  boundary is enforced rather than remembered.                            │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * The fallback is the skeleton grid the dashboard already shows while loading,
 * so the lazy chunk arriving is invisible: same eight boxes, same dimensions.
 */
const AnimatedGrid = lazy(() => import('./AnimatedGrid.js'))

const GRID =
  'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'

export function BoardGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className={GRID} aria-busy="true" aria-live="polite" data-testid="board-grid-loading">
      {Array.from({ length: count }, (_, i) => (
        <BoardCardSkeleton key={i} />
      ))}
    </div>
  )
}

export function BoardGrid({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<div className={GRID}>{children}</div>}>
      <AnimatedGrid className={GRID}>{children}</AnimatedGrid>
    </Suspense>
  )
}
