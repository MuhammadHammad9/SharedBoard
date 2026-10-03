import { useBoardStore } from '../../stores/boardStore.js'
import { actions, boardChrome, errors } from '../../lib/strings.js'
import { Button } from '../../components/ui/Button.js'
import {
  removeUpload,
  retryUpload,
  useUploadStore,
  type UploadItem,
} from './uploadEngine.js'

/**
 * Upload placeholders — FR-CANVAS-010: "a placeholder rectangle with a
 * progress ring at the drop position"; failures show "Upload failed." with
 * Retry and Remove (PRD §8.2).
 *
 * DOM, over the canvas, positioned with the same transform the renderer uses
 * (the TextOverlay pattern). Not drawn on a canvas layer: the ring moves, and
 * the canvas is a no-decoration zone (R-MOTION-004). The ring is LINEAR — a
 * progress indicator with easing misrepresents progress (Phase 13 motion).
 *
 * Narrow selectors (R-ARCH-003): the viewport and the uploads, never objects.
 */

const RING = 18
const CIRCUMFERENCE = 2 * Math.PI * RING

export function UploadPlaceholders() {
  const items = useUploadStore(s => s.items)
  const viewport = useBoardStore(s => s.viewport)
  const list = Object.values(items)
  if (list.length === 0) return null

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {list.map(item => (
        <Placeholder key={item.id} item={item} viewport={viewport} />
      ))}
    </div>
  )
}

function Placeholder({
  item,
  viewport,
}: {
  item: UploadItem
  viewport: { x: number; y: number; zoom: number }
}) {
  const failed = item.status === 'failed'
  const style = {
    left: item.box.x * viewport.zoom + viewport.x,
    top: item.box.y * viewport.zoom + viewport.y,
    width: item.box.width * viewport.zoom,
    height: item.box.height * viewport.zoom,
  }

  return (
    <div
      className={`absolute flex flex-col items-center justify-center gap-2 rounded-sm border bg-subtle/90 ${
        failed ? 'pointer-events-auto border-danger/40' : 'border-border'
      }`}
      style={style}
      role={failed ? 'alert' : 'status'}
      aria-label={failed ? errors.uploadFailed : boardChrome.uploading(item.file.name)}
      data-testid="upload-placeholder"
      data-upload-placeholder
      data-status={item.status}
    >
      {failed ? (
        <>
          <p className="text-xs text-danger">{errors.uploadFailed}</p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => retryUpload(item.id)}
              data-testid="upload-retry"
            >
              {actions.retry}
            </Button>
            <Button
              variant="ghost"
              onClick={() => removeUpload(item.id)}
              data-testid="upload-remove"
            >
              {actions.remove}
            </Button>
          </div>
        </>
      ) : (
        <svg
          width={RING * 2 + 6}
          height={RING * 2 + 6}
          viewBox={`0 0 ${RING * 2 + 6} ${RING * 2 + 6}`}
          aria-hidden="true"
          className="-rotate-90"
        >
          <circle
            cx={RING + 3}
            cy={RING + 3}
            r={RING}
            fill="none"
            strokeWidth={3}
            className="stroke-border"
          />
          <circle
            data-upload-ring
            cx={RING + 3}
            cy={RING + 3}
            r={RING}
            fill="none"
            strokeWidth={3}
            strokeLinecap="round"
            className="stroke-accent"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - item.progress)}
          />
        </svg>
      )}
    </div>
  )
}
