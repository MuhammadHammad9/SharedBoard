import { Trash } from '@phosphor-icons/react'
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  PEN_COLOURS,
  STICKY_COLOURS,
  STROKE_WIDTH_MAX,
  STROKE_WIDTH_MIN,
  type BoardObject,
} from '@coboard/shared'
import { selectedObjects, useBoardStore } from '../../../stores/boardStore.js'
import {
  applyAndEmit,
  deleteOps,
  updateOps,
} from '../../../features/canvas/history/apply.js'
import { LABELS } from '../../../features/canvas/history/grouping.js'
import { ColorSwatch } from '../../ui/ColorSwatch.js'
import { Slider } from '../../ui/Slider.js'
import { MIXED, MixedValue, commonValue } from './MixedValue.js'

/**
 * Properties for the current selection — FLOWS §14.4.
 *
 * §14.4 has three multi-selection rows: same type shows the shared property
 * set, mixed types show only universally shared properties, and differing
 * values render as "Mixed". All three fall out of one rule — offer a control
 * when EVERY selected object has that property, and show "Mixed" when they
 * disagree on its value — so there is no per-combination branching to get
 * wrong as new types arrive.
 *
 * `opacity` lives on BaseObject and is therefore the one universally shared
 * property: it is the whole panel for a mixed-type selection.
 *
 * R-ARCH-003: subscribes to the selection array and the object VERSION, never
 * to the object Map. It re-renders when the selection changes and when a
 * transform commits — a few times a second at most, not sixty.
 */

type Kind = 'stroke' | 'shape' | 'sticky' | 'text' | 'mixed'

function kindOf(objects: readonly BoardObject[]): Kind {
  const kinds = new Set(
    objects.map(o =>
      o.type === 'stroke'
        ? 'stroke'
        : o.type === 'sticky'
          ? 'sticky'
          : o.type === 'text'
            ? 'text'
            : o.type === 'image'
              ? 'image'
              : 'shape',
    ),
  )
  if (kinds.size !== 1) return 'mixed'
  const only = [...kinds][0]
  return only === 'image' ? 'mixed' : (only as Kind)
}

export function SelectionProperties() {
  const selectionCount = useBoardStore(s => s.selection.length)
  // Reading the version rather than the objects keeps the subscription narrow
  // while still refreshing after a transform or an edit commits.
  useBoardStore(s => s.objectsVersion)
  const selection = useBoardStore(s => s.selection)

  const objects = selectedObjects()
  if (objects.length === 0) return null

  const kind = kindOf(objects)
  const opacity = commonValue(objects, o => o.opacity)

  /**
   * Apply a patch to every selected object, in one batched commit and one undo
   * entry (R-UNDO-004).
   *
   * `updateOps` diffs each object against the store, so re-selecting the
   * colour a shape already has produces no op and no history entry — the undo
   * stack records changes, not clicks.
   */
  const patch = (fn: (o: BoardObject) => BoardObject) =>
    applyAndEmit(
      updateOps(objects.map(o => ({ ...fn(o), updatedAt: Date.now() }))),
      LABELS.style,
    )

  /** A colour row, reused by every type that has one. */
  const colourRow = (
    label: string,
    palette: readonly string[],
    read: (o: BoardObject) => string | undefined,
    write: (o: BoardObject, colour: string) => BoardObject,
    columns = 5,
  ) => {
    const current = commonValue(objects, read)
    return (
      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h4 className="text-xs font-medium text-muted">{label}</h4>
          {current === MIXED && <MixedValue />}
        </div>
        <div
          className={`grid gap-2 ${columns === 4 ? 'grid-cols-4' : 'grid-cols-5'}`}
          role="group"
          aria-label={label}
        >
          {palette.map(c => (
            <ColorSwatch
              key={c}
              color={c}
              context={label === 'Colour' ? 'Colour' : `${label} colour`}
              selected={
                current !== MIXED &&
                typeof current === 'string' &&
                current.toLowerCase() === c.toLowerCase()
              }
              onSelect={next => patch(o => write(o, next))}
            />
          ))}
        </div>
      </section>
    )
  }

  const width = commonValue(objects, o =>
    'strokeWidth' in o ? (o as { strokeWidth: number }).strokeWidth : undefined,
  )
  const fontSize = commonValue(objects, o => (o.type === 'text' ? o.fontSize : undefined))

  return (
    <div className="flex flex-col gap-4" data-testid="selection-properties">
      <header className="flex items-baseline justify-between">
        <h3 className="text-xs font-medium text-muted">
          {selectionCount === 1 ? '1 object' : `${selectionCount} objects`}
        </h3>
      </header>

      {kind === 'stroke' &&
        colourRow(
          'Colour',
          PEN_COLOURS,
          o => (o.type === 'stroke' ? o.color : undefined),
          (o, c) => (o.type === 'stroke' ? { ...o, color: c } : o),
        )}

      {kind === 'shape' &&
        colourRow(
          'Stroke',
          PEN_COLOURS,
          o => ('stroke' in o ? (o as { stroke: string }).stroke : undefined),
          (o, c) => ('stroke' in o ? { ...o, stroke: c } : o),
        )}

      {kind === 'sticky' &&
        colourRow(
          'Colour',
          Object.values(STICKY_COLOURS),
          o => (o.type === 'sticky' ? o.color : undefined),
          (o, c) => (o.type === 'sticky' ? { ...o, color: c } : o),
          4,
        )}

      {kind === 'text' &&
        colourRow(
          'Colour',
          PEN_COLOURS,
          o => (o.type === 'text' ? o.color : undefined),
          (o, c) => (o.type === 'text' ? { ...o, color: c } : o),
        )}

      {(kind === 'stroke' || kind === 'shape') && (
        <Slider
          label="Stroke width"
          value={width === MIXED || width === undefined ? STROKE_WIDTH_MIN : width}
          min={STROKE_WIDTH_MIN}
          max={STROKE_WIDTH_MAX}
          display={width === MIXED ? 'Mixed' : `${width ?? STROKE_WIDTH_MIN} px`}
          mixed={width === MIXED}
          testId="selection-width-slider"
          onChange={next =>
            patch(o => ('strokeWidth' in o ? { ...o, strokeWidth: next } : o))
          }
        />
      )}

      {kind === 'text' && (
        <Slider
          label="Font size"
          value={fontSize === MIXED || fontSize === undefined ? FONT_SIZE_MIN : fontSize}
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          display={fontSize === MIXED ? 'Mixed' : `${fontSize ?? FONT_SIZE_MIN} px`}
          mixed={fontSize === MIXED}
          testId="selection-fontsize-slider"
          onChange={next =>
            patch(o => (o.type === 'text' ? { ...o, fontSize: next } : o))
          }
        />
      )}

      {/* The universally shared property — the whole panel for a mixed selection. */}
      <Slider
        label="Opacity"
        value={Math.round(
          (opacity === MIXED || opacity === undefined ? 1 : opacity) * 100,
        )}
        min={10}
        max={100}
        step={5}
        display={opacity === MIXED ? 'Mixed' : `${Math.round((opacity ?? 1) * 100)}%`}
        mixed={opacity === MIXED}
        testId="selection-opacity-slider"
        onChange={next => patch(o => ({ ...o, opacity: next / 100 }))}
      />

      {/* Z-order beyond front/back is FR-CANVAS-016, Phase 9. Both of those
          live in the context menu, where §14.4 and FLOWS §14.2 put them. */}

      <button
        type="button"
        // FR-CANVAS-014, and undoable: applyAndEmit snapshots each object
        // before it goes, so the inverse CREATEs restore them intact.
        onClick={() => applyAndEmit(deleteOps(selection), LABELS.delete)}
        data-testid="selection-delete"
        className={
          'flex h-8 cursor-pointer items-center justify-center gap-2 rounded-sm ' +
          'text-xs text-danger transition-colors duration-fast ease-standard ' +
          'hover:bg-danger/10 active:scale-[0.97] ' +
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-danger'
        }
      >
        <Trash size={14} weight="light" aria-hidden="true" />
        Delete
      </button>
    </div>
  )
}
