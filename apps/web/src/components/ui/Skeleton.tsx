/**
 * Skeleton — the dashboard's loading state, `R-UI-051`.
 *
 * Skeletons, not a spinner, and the reason is layout rather than taste: eight
 * cards at the real dimensions occupy exactly the space the loaded grid will,
 * so nothing moves when the data lands. A centred spinner reserves nothing and
 * the whole page jumps.
 *
 * The shimmer is a `transform: translateX()` loop on a gradient — the one
 * animation in the product that runs continuously, and so the one that must
 * not touch layout or paint. `linear`, because constant motion with easing
 * appears to stutter (`R-MOTION-011`).
 *
 * `aria-hidden`: a screen reader gains nothing from eight fake cards. The
 * grid's own `aria-busy` is what announces the wait.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`coboard-skeleton rounded-md ${className}`} />
}

/** One card's worth of skeleton, at the real card's dimensions. */
export function BoardCardSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-lg border border-border bg-app"
      data-testid="board-card-skeleton"
    >
      {/* 16:10, matching BoardCard's thumbnail, so the grid does not reflow. */}
      <Skeleton className="aspect-[16/10] w-full rounded-none" />
      <div className="flex flex-col gap-2 p-3">
        <Skeleton className="h-4 w-3/5" />
        <Skeleton className="h-3 w-2/5" />
      </div>
    </div>
  )
}
