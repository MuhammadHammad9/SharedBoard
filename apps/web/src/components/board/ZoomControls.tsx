import { Minus, Plus, CornersOut } from '@phosphor-icons/react'
import { ZOOM_MAX, ZOOM_MIN } from '@coboard/shared'
import { useBoardStore } from '../../stores/boardStore.js'
import { boardChrome } from '../../lib/strings.js'
import { useBreakpoint } from '../../lib/breakpoints.js'

/**
 * Zoom controls — FLOWS §14.2. Bottom-right, 16 px margins, z-index: panel.
 *
 * Zone: Board chrome. Skills: ui-ux-pro-max + emil-design-eng. Dials 4/2/6.
 *
 * Motion (R-MOTION-001): zooming is a top-band interaction — performed
 * constantly — so the viewport change itself never animates. The only motion
 * here is the press feedback, scale(0.97) at 120 ms (R-MOTION-033), and a
 * colour transition on hover. No layout-shifting transforms (R-UI-021).
 *
 * R-ARCH-003: subscribes to the zoom NUMBER only, never the object map.
 */

interface ZoomControlsProps {
  getSize: () => { width: number; height: number }
}

const BUTTON =
  'flex h-8 w-8 items-center justify-center rounded-sm text-primary ' +
  'transition-colors duration-fast ease-standard cursor-pointer ' +
  'hover:bg-subtle active:scale-[0.97] ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ' +
  'disabled:cursor-not-allowed disabled:opacity-40'

export function ZoomControls({ getSize }: ZoomControlsProps) {
  // Narrow selector — R-ARCH-003.
  const zoom = useBoardStore(s => s.viewport.zoom)
  // On mobile it sits above the 56 px bottom bar (FLOWS §14.5).
  const breakpoint = useBreakpoint()
  const zoomAt = useBoardStore(s => s.zoomAt)
  const resetZoom = useBoardStore(s => s.resetZoom)
  const zoomToFit = useBoardStore(s => s.zoomToFit)

  const centre = () => {
    const { width, height } = getSize()
    return { x: width / 2, y: height / 2 }
  }

  const percent = Math.round(zoom * 100)
  const atMin = zoom <= ZOOM_MIN + 1e-9
  const atMax = zoom >= ZOOM_MAX - 1e-9

  return (
    <div
      className={`pointer-events-auto absolute ${breakpoint === 'mobile' ? 'bottom-20' : 'bottom-4'} right-4 z-panel flex items-center gap-1 rounded-md border border-border bg-app p-1 shadow-panel`}
      role="group"
      aria-label={boardChrome.zoom.label}
      data-testid="zoom-controls"
    >
      <button
        type="button"
        className={BUTTON}
        aria-label={boardChrome.zoom.zoomOut}
        disabled={atMin}
        onClick={() => {
          const c = centre()
          zoomAt(c.x, c.y, 1 / 1.2)
        }}
      >
        <Minus size={16} weight="light" aria-hidden="true" />
      </button>

      <button
        type="button"
        className="min-w-[3.5rem] rounded-sm px-2 py-1 text-center text-sm tabular-nums text-primary transition-colors duration-fast ease-standard cursor-pointer hover:bg-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        aria-label={boardChrome.zoom.percent(percent)}
        data-testid="zoom-percent"
        onClick={() => {
          const c = centre()
          resetZoom(c.x, c.y)
        }}
      >
        {percent}%
      </button>

      <button
        type="button"
        className={BUTTON}
        aria-label={boardChrome.zoom.zoomIn}
        disabled={atMax}
        onClick={() => {
          const c = centre()
          zoomAt(c.x, c.y, 1.2)
        }}
      >
        <Plus size={16} weight="light" aria-hidden="true" />
      </button>

      <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

      <button
        type="button"
        className={BUTTON}
        aria-label={boardChrome.zoom.zoomToFit}
        data-testid="zoom-to-fit"
        onClick={() => {
          const { width, height } = getSize()
          zoomToFit(width, height)
        }}
      >
        <CornersOut size={16} weight="light" aria-hidden="true" />
      </button>
    </div>
  )
}
