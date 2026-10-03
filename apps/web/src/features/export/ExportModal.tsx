import { useEffect, useMemo, useState } from 'react'
import type { Rect } from '@coboard/shared'
import { Modal } from '../../components/ui/Modal.js'
import { Button } from '../../components/ui/Button.js'
import { useToast } from '../../components/ui/Toast.js'
import { actions, errors, exportStrings as t } from '../../lib/strings.js'
import { track } from '../../lib/analytics.js'
import { boardStore, objectsInZOrder, useBoardStore } from '../../stores/boardStore.js'
import {
  clampScale,
  exportContent,
  renderExport,
  toPngBlob,
  type ExportOptions,
  type ExportScope,
} from './renderToCanvas.js'
import { downloadBlob, exportFilename } from './download.js'
import { closeExport, useExportStore } from './exportStore.js'

/**
 * S-14 — export, FLOWS §11, FR-EXPORT-001.
 *
 * Zone: board chrome. No Framer Motion (R-SKILL-060): the modal is the shared
 * 200 ms opacity + translateY(8px), and the preview crossfades in 150 ms on
 * opacity only (Phase 13 motion table). The progress bar is linear.
 *
 * The live preview is "the single most useful affordance in an export dialog"
 * (Phase 13 UI): it re-renders whenever an option changes, from the same
 * renderer as the export itself.
 */

const PREVIEW_W = 360
const PREVIEW_H = 200
const DEFAULT_PADDING = 24
const MAX_PADDING = 256

export function ExportModal({
  boardName,
  getSize,
}: {
  boardName: string
  /** The canvas's size in CSS px, for the visible-area scope. */
  getSize: () => { width: number; height: number }
}) {
  const open = useExportStore(s => s.open)
  if (!open) return null
  return <ExportDialog boardName={boardName} getSize={getSize} />
}

function ExportDialog({
  boardName,
  getSize,
}: {
  boardName: string
  getSize: () => { width: number; height: number }
}) {
  const toast = useToast()
  const hasSelection = useBoardStore(s => s.selection.length > 0)
  const [options, setOptions] = useState<ExportOptions>({
    scope: hasSelection ? 'selection' : 'board',
    scale: 1,
    transparent: true,
    padding: DEFAULT_PADDING,
  })
  const [preview, setPreview] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const set = <K extends keyof ExportOptions>(key: K, value: ExportOptions[K]) =>
    setOptions(o => ({ ...o, [key]: value }))

  const visible = useMemo((): Rect => {
    const { x, y, zoom } = boardStore.getState().viewport
    const { width, height } = getSize()
    return { x: -x / zoom, y: -y / zoom, width: width / zoom, height: height / zoom }
  }, [getSize])

  const content = () =>
    exportContent(
      options.scope,
      objectsInZOrder(),
      new Set(boardStore.getState().selection),
      visible,
      options.padding,
    )

  // The live preview. Revoked on every change, so previews never pile up.
  useEffect(() => {
    let cancelled = false
    let url: string | null = null
    const found = content()
    if (!found) {
      setPreview(null)
      return
    }
    const fit = Math.min(PREVIEW_W / found.rect.width, PREVIEW_H / found.rect.height, 2)
    void renderExport({ ...found, scale: fit, transparent: options.transparent })
      .then(toPngBlob)
      .then(blob => {
        if (cancelled) return
        url = URL.createObjectURL(blob)
        setPreview(url)
      })
      .catch(() => {
        if (!cancelled) setPreview(null)
      })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
    // `content` reads the store at call time; the options are the inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, visible])

  const onExport = async () => {
    const found = content()
    // E-22: never a transparent 1×1 file. Block, and say why.
    if (!found) {
      toast.show({ message: t.nothingToExport })
      return
    }
    const { scale, clamped } = clampScale(found.rect, options.scale)
    if (clamped) toast.show({ message: t.scaledDown })
    setProgress(0)
    try {
      const canvas = await renderExport({
        ...found,
        scale,
        transparent: options.transparent,
        onProgress: setProgress,
      })
      downloadBlob(await toPngBlob(canvas), exportFilename(boardName))
      track('export_completed', { format: 'png', scope: options.scope })
      closeExport()
      toast.show({ message: t.exported })
    } catch {
      setProgress(null)
      toast.show({ message: errors.genericServerError, variant: 'danger' })
    }
  }

  const busy = progress !== null
  const scopes: Array<[ExportScope, string, boolean]> = [
    ['board', t.wholeBoard, false],
    ['selection', t.currentSelection, !hasSelection],
    ['visible', t.visibleArea, false],
  ]

  return (
    <Modal
      open
      onClose={() => !busy && closeExport()}
      title={t.title}
      testId="export-modal"
      footer={
        <>
          <Button variant="secondary" onClick={closeExport} disabled={busy}>
            {actions.cancel}
          </Button>
          <Button
            onClick={() => void onExport()}
            loading={busy}
            data-testid="export-confirm"
          >
            {t.export}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-primary">
        <div
          className="grid h-[200px] place-items-center overflow-hidden rounded-md border border-border bg-subtle"
          aria-label={t.preview}
          role="img"
          data-testid="export-preview"
        >
          {preview && (
            <img
              key={preview}
              src={preview}
              alt=""
              data-export-preview
              className="max-h-full max-w-full"
            />
          )}
        </div>

        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium">{t.scope}</legend>
          {scopes.map(([value, label, disabled]) => (
            <label
              key={value}
              className={`flex items-center gap-2 text-sm ${disabled ? 'text-muted' : 'cursor-pointer'}`}
            >
              <input
                type="radio"
                name="export-scope"
                value={value}
                checked={options.scope === value}
                disabled={disabled || busy}
                onChange={() => set('scope', value)}
                data-testid={`export-scope-${value}`}
              />
              {label}
            </label>
          ))}
        </fieldset>

        <fieldset className="flex items-center gap-4">
          <legend className="sr-only">{t.format}</legend>
          <span className="w-24 text-sm font-medium">{t.format}</span>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="radio" name="export-format" checked readOnly /> {t.png}
          </label>
          <label
            className="flex items-center gap-2 text-sm text-muted"
            title={t.svgLater}
          >
            <input type="radio" name="export-format" disabled /> {t.svg}
          </label>
        </fieldset>

        <div className="flex items-center gap-4">
          <span className="w-24 text-sm font-medium" id="export-scale">
            {t.scale}
          </span>
          <div role="radiogroup" aria-labelledby="export-scale" className="flex gap-1">
            {([1, 2] as const).map(value => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={options.scale === value}
                disabled={busy}
                onClick={() => set('scale', value)}
                data-testid={`export-scale-${value}`}
                className={`h-8 cursor-pointer rounded-sm border px-3 text-sm transition-colors duration-fast focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                  options.scale === value
                    ? 'border-accent bg-accent text-white'
                    : 'border-border bg-app text-primary hover:bg-subtle'
                }`}
              >
                {value}×
              </button>
            ))}
          </div>
        </div>

        <label className="flex cursor-pointer items-center gap-4 text-sm">
          <span className="w-24 font-medium">{t.background}</span>
          <input
            type="checkbox"
            checked={options.transparent}
            disabled={busy}
            onChange={e => set('transparent', e.target.checked)}
            data-testid="export-transparent"
          />
          {t.transparent}
        </label>

        <label className="flex items-center gap-4 text-sm">
          <span className="w-24 font-medium">{t.padding}</span>
          <input
            type="number"
            min={0}
            max={MAX_PADDING}
            value={options.padding}
            disabled={busy || options.scope === 'visible'}
            onChange={e =>
              set(
                'padding',
                Math.max(0, Math.min(MAX_PADDING, Number(e.target.value) || 0)),
              )
            }
            className="h-8 w-20 rounded-sm border border-border bg-app px-2 text-sm"
            data-testid="export-padding"
          />
          px
        </label>

        {busy && (
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          >
            <p className="mb-1 text-xs text-muted">
              {t.rendering(Math.round(progress * 100))}
            </p>
            <div className="h-1 overflow-hidden rounded-sm bg-subtle">
              <div
                data-export-progress
                className="h-full origin-left bg-accent"
                style={{ transform: `scaleX(${progress})` }}
              />
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
