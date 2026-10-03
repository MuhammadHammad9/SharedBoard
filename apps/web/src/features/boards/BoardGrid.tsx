import { Children, lazy, Suspense, type ReactNode } from 'react'
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
 * so the lazy chunk arriving is invisible: same boxes, same dimensions.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  NEVER the cards themselves as the fallback.                             │
 * │                                                                          │
 * │  It looked harmless — show the real cards until the animated grid       │
 * │  arrives — but the swap from fallback to AnimatedGrid moves every card   │
 * │  to a new parent, and React remounts them. A `⋮` menu opened in that     │
 * │  window closes, focus drops to <body>, and an inline rename in progress  │
 * │  is thrown away. Under load the chunk lands late enough to hit; this     │
 * │  was the S-08 dashboard flake. Cards now mount once, in the final tree.  │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * The import starts when this module loads (the dashboard chunk), not when the
 * first grid renders, so it is normally in hand by the time the list arrives.
 */
const loadAnimatedGrid = () => import('./AnimatedGrid.js')
void loadAnimatedGrid()
const AnimatedGrid = lazy(loadAnimatedGrid)

const GRID = 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'

export function BoardGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div
      className={GRID}
      aria-busy="true"
      aria-live="polite"
      data-testid="board-grid-loading"
    >
      {Array.from({ length: count }, (_, i) => (
        <BoardCardSkeleton key={i} />
      ))}
    </div>
  )
}

export function BoardGrid({ children }: { children: ReactNode }) {
  const count = Children.count(children)
  return (
    <Suspense fallback={<BoardGridSkeleton count={Math.min(Math.max(count, 1), 8)} />}>
      <AnimatedGrid className={GRID}>{children}</AnimatedGrid>
    </Suspense>
  )
}
