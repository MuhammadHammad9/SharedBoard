import { useEffect, useState, type ReactNode } from 'react'
import { Spinner } from '../ui/Spinner.js'
import { loading } from '../../lib/strings.js'

/** FLOWS §8.1: past this long, the spinner gets words — "Loading 4,312 objects…". */
export const LOADING_COPY_AFTER_MS = 2_000

/**
 * The board's frame while it loads — FLOWS §2.3 STEP 1 and §8.1: header
 * skeleton, a disabled toolbar placeholder, and the canvas area with a centred
 * spinner. The SAME frame from the access check through to the snapshot, so
 * the screen does not swap from one loading state to another half-way.
 *
 * `objectCount`, when the access response gave one, turns into "Loading N
 * objects…" after 2 s (FLOWS §8.1: "Silence past 2 seconds reads as a broken
 * page"). Without a count the generic label shows at the same point instead.
 *
 * Zone: board chrome. No motion beyond the spinner itself.
 */
export function BoardShell({
  children,
  objectCount = null,
}: {
  children?: ReactNode
  objectCount?: number | null
}) {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (children) return
    const id = setTimeout(() => setSlow(true), LOADING_COPY_AFTER_MS)
    return () => clearTimeout(id)
  }, [children])

  return (
    <main
      className="relative h-[100dvh] min-h-[100dvh] w-full overflow-hidden bg-canvas"
      data-testid="board-shell"
      aria-busy={children ? undefined : true}
    >
      <div className="absolute inset-x-4 top-4 flex items-center gap-2">
        <div className="h-8 w-48 rounded-md bg-app/90 shadow-panel" />
        <div className="ml-auto h-8 w-24 rounded-md bg-app/90 shadow-panel" />
      </div>
      <div className="absolute left-4 top-1/2 h-64 w-12 -translate-y-1/2 rounded-md bg-app/90 opacity-60 shadow-panel" />
      <div className="grid h-full place-items-center" role="status" aria-live="polite">
        {children ?? (
          <div className="flex flex-col items-center gap-3">
            <Spinner size={28} className="text-accent" />
            {slow && (
              <p className="text-sm text-muted" data-testid="board-loading-copy">
                {objectCount !== null && objectCount > 0
                  ? loading.objects(objectCount)
                  : loading.board}
              </p>
            )}
          </div>
        )}
      </div>
    </main>
  )
}
