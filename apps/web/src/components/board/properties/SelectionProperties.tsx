import {
  ArrowsIn,
  TextAlignCenter,
  TextAlignLeft,
  TextAlignRight,
  TextB,
  TextItalic,
  Trash,
} from '@phosphor-icons/react'
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
import {
  ArrowheadControl,
  LayerControls,
  StickyFontControl,
  toggleClass,
} from './controls.js'
import { arrowheadsOf, withArrowheads } from '../../../features/canvas/arrowheads.js'
import { boardChrome } from '../../../lib/strings.js'

const p = boardChrome.properties

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

type Kind = 'stroke' | 'shape' | 'sticky' | 'text' | 'image' | 'mixed'

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
  return [...kinds][0] as Kind
}

const ALIGNMENTS = [
  { value: 'left' as const, icon: TextAlignLeft, label: p.alignLeft },
  { value: 'center' as const, icon: TextAlignCenter, label: p.alignCentre },
  { value: 'right' as const, icon: TextAlignRight, label: p.alignRight },
]

/** A value that is not MIXED and not absent, or undefined. */
const definite = <V,>(v: V | undefined | typeof MIXED): V | undefined =>
  v === MIXED ? undefined : v

/** Interaction states driven by a live pointer, where geometry streams. */
const isPointerGesture = (type: string): boolean =>
  type !== 'IDLE' && type !== 'EDITING_TEXT'

export function SelectionProperties() {
  const selectionCount = useBoardStore(s => s.selection.length)
  /*
   * Reading the version rather than the objects keeps the subscription narrow
   * while still refreshing after a transform, an edit or a remote change.
   *
   * Frozen while a pointer gesture is live: a drag bumps the version on every
   * pointermove, and re-rendering the panel sixty times a second for values
   * it does not show (geometry) is exactly R-ARCH-003's failure. The gesture
   * ending flips the selector back to the live version, so the panel catches
   * up — including with anything a teammate changed meanwhile — in one render.
   */
  useBoardStore(s => (isPointerGesture(s.interaction.type) ? -1 : s.objectsVersion))
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
    context: string,
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
              context={context}
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
  const fill = commonValue(objects, o =>
    'fill' in o ? (o as { fill: string }).fill : undefined,
  )
  const radius = commonValue(objects, o =>
    o.type === 'rect' || o.type === 'image' ? (o.cornerRadius ?? 0) : undefined,
  )
  const heads = commonValue(objects, arrowheadsOf)
  const bold = commonValue(objects, o => (o.type === 'text' ? o.bold : undefined))
  const italic = commonValue(objects, o => (o.type === 'text' ? o.italic : undefined))
  const align = commonValue(objects, o => (o.type === 'text' ? o.textAlign : undefined))
  const stickyFont = commonValue(objects, o =>
    o.type === 'sticky' ? o.fontSize : undefined,
  )

  return (
    <div className="flex flex-col gap-4" data-testid="selection-properties">
      <header className="flex items-baseline justify-between">
        <h3 className="text-xs font-medium text-muted">
          {p.objectCount(selectionCount)}
        </h3>
      </header>

      {kind === 'stroke' &&
        colourRow(
          p.colour,
          p.colour,
          PEN_COLOURS,
          o => (o.type === 'stroke' ? o.color : undefined),
          (o, c) => (o.type === 'stroke' ? { ...o, color: c } : o),
        )}

      {kind === 'shape' &&
        colourRow(
          p.stroke,
          p.strokeColour,
          PEN_COLOURS,
          o => ('stroke' in o ? (o as { stroke: string }).stroke : undefined),
          (o, c) => ('stroke' in o ? { ...o, stroke: c } : o),
        )}

      {kind === 'sticky' &&
        colourRow(
          p.colour,
          p.colour,
          Object.values(STICKY_COLOURS),
          o => (o.type === 'sticky' ? o.color : undefined),
          (o, c) => (o.type === 'sticky' ? { ...o, color: c } : o),
          4,
        )}

      {kind === 'text' &&
        colourRow(
          p.colour,
          p.colour,
          PEN_COLOURS,
          o => (o.type === 'text' ? o.color : undefined),
          (o, c) => (o.type === 'text' ? { ...o, color: c } : o),
        )}

      {(kind === 'stroke' || kind === 'shape') && (
        <Slider
          label={p.strokeWidth}
          value={width === MIXED || width === undefined ? STROKE_WIDTH_MIN : width}
          min={STROKE_WIDTH_MIN}
          max={STROKE_WIDTH_MAX}
          display={width === MIXED ? p.mixed : `${width ?? STROKE_WIDTH_MIN} px`}
          mixed={width === MIXED}
          testId="selection-width-slider"
          onChange={next =>
            patch(o => ('strokeWidth' in o ? { ...o, strokeWidth: next } : o))
          }
        />
      )}

      {kind === 'text' && (
        <Slider
          label={p.fontSize}
          value={fontSize === MIXED || fontSize === undefined ? FONT_SIZE_MIN : fontSize}
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          display={fontSize === MIXED ? p.mixed : `${fontSize ?? FONT_SIZE_MIN} px`}
          mixed={fontSize === MIXED}
          testId="selection-fontsize-slider"
          onChange={next =>
            patch(o => (o.type === 'text' ? { ...o, fontSize: next } : o))
          }
        />
      )}

      {kind === 'shape' &&
        objects.every(o => o.type === 'rect' || o.type === 'ellipse') && (
          <section className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <h4 className="text-xs font-medium text-muted">{p.fill}</h4>
              {fill === MIXED && <MixedValue />}
            </div>
            <div
              className="grid grid-cols-5 gap-2"
              role="group"
              aria-label={p.fillColour}
            >
              <button
                type="button"
                aria-label={p.fillNone}
                aria-pressed={fill === 'none'}
                data-testid="selection-fill-none"
                onClick={() => patch(o => ('fill' in o ? { ...o, fill: 'none' } : o))}
                className={
                  'relative flex h-6 w-6 cursor-pointer items-center justify-center rounded-sm ' +
                  'bg-app transition-transform duration-fast ease-out active:scale-[0.97] ' +
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
                  'focus-visible:outline-accent ' +
                  (fill === 'none'
                    ? 'ring-2 ring-accent ring-offset-2 ring-offset-app'
                    : 'ring-1 ring-border')
                }
              >
                <span
                  className="absolute h-px w-5 rotate-45 bg-danger"
                  aria-hidden="true"
                />
              </button>
              {PEN_COLOURS.slice(0, 9).map(c => (
                <ColorSwatch
                  key={c}
                  color={c}
                  context={p.fillColour}
                  selected={
                    typeof fill === 'string' && fill.toLowerCase() === c.toLowerCase()
                  }
                  onSelect={next => patch(o => ('fill' in o ? { ...o, fill: next } : o))}
                />
              ))}
            </div>
          </section>
        )}

      {((kind === 'shape' && objects.every(o => o.type === 'rect')) ||
        kind === 'image') && (
        <Slider
          label={p.cornerRadius}
          value={definite(radius) ?? 0}
          min={0}
          max={64}
          display={radius === MIXED ? p.mixed : `${radius ?? 0} px`}
          mixed={radius === MIXED}
          testId="selection-radius-slider"
          onChange={next =>
            patch(o =>
              o.type === 'rect' || o.type === 'image' ? { ...o, cornerRadius: next } : o,
            )
          }
        />
      )}

      {kind === 'shape' &&
        objects.every(o => o.type === 'line' || o.type === 'arrow') && (
          <ArrowheadControl
            value={definite(heads)}
            onChange={next => patch(o => withArrowheads(o, next))}
          />
        )}

      {kind === 'text' && (
        <>
          <section className="flex flex-col gap-2">
            <h4 className="text-xs font-medium text-muted">{p.style}</h4>
            <div className="flex gap-1" role="group" aria-label={p.textStyle}>
              <button
                type="button"
                aria-label={p.bold}
                aria-pressed={bold === true}
                data-testid="selection-bold"
                onClick={() =>
                  patch(o => (o.type === 'text' ? { ...o, bold: bold !== true } : o))
                }
                className={toggleClass(bold === true)}
              >
                <TextB size={16} weight="light" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={p.italic}
                aria-pressed={italic === true}
                data-testid="selection-italic"
                onClick={() =>
                  patch(o => (o.type === 'text' ? { ...o, italic: italic !== true } : o))
                }
                className={toggleClass(italic === true)}
              >
                <TextItalic size={16} weight="light" aria-hidden="true" />
              </button>
            </div>
          </section>
          <section className="flex flex-col gap-2">
            <h4 className="text-xs font-medium text-muted">{p.alignment}</h4>
            <div className="flex gap-1" role="group" aria-label={p.textAlignment}>
              {ALIGNMENTS.map(({ value, icon: Icon, label }) => (
                <button
                  key={value}
                  type="button"
                  aria-label={label}
                  aria-pressed={align === value}
                  data-testid={`selection-align-${value}`}
                  onClick={() =>
                    patch(o => (o.type === 'text' ? { ...o, textAlign: value } : o))
                  }
                  className={toggleClass(align === value)}
                >
                  <Icon size={16} weight="light" aria-hidden="true" />
                </button>
              ))}
            </div>
          </section>
        </>
      )}

      {kind === 'sticky' && (
        <StickyFontControl
          value={definite(stickyFont)}
          onChange={next =>
            patch(o => (o.type === 'sticky' ? { ...o, fontSize: next } : o))
          }
        />
      )}

      {kind === 'image' && selectionCount === 1 && (
        <button
          type="button"
          // FLOWS §14.4 "Reset size": back to the image's natural pixel size,
          // anchored at its top-left. One UPDATE, one undo entry.
          onClick={() =>
            patch(o =>
              o.type === 'image'
                ? { ...o, width: o.naturalWidth, height: o.naturalHeight }
                : o,
            )
          }
          data-testid="selection-reset-size"
          className={`${toggleClass(false)} gap-2 text-xs`}
        >
          <ArrowsIn size={14} weight="light" aria-hidden="true" />
          {p.resetSize}
        </button>
      )}

      {/* The universally shared property — the whole panel for a mixed selection. */}
      <Slider
        label={p.opacity}
        value={Math.round(
          (opacity === MIXED || opacity === undefined ? 1 : opacity) * 100,
        )}
        min={10}
        max={100}
        step={5}
        display={opacity === MIXED ? p.mixed : `${Math.round((opacity ?? 1) * 100)}%`}
        mixed={opacity === MIXED}
        testId="selection-opacity-slider"
        onChange={next => patch(o => ({ ...o, opacity: next / 100 }))}
      />

      {/* FLOWS §14.4: "z-order controls" for every selection — FR-CANVAS-016. */}
      <LayerControls />

      <button
        type="button"
        // FR-CANVAS-014, and undoable: applyAndEmit snapshots each object
        // before it goes, so the inverse CREATEs restore them intact.
        onClick={() => applyAndEmit(deleteOps(selection), LABELS.delete)}
        data-testid="selection-delete"
        className={
          'flex h-8 cursor-pointer items-center justify-center gap-2 rounded-sm ' +
          'text-xs text-danger transition-colors duration-fast ease-standard ' +
          'hover:bg-danger hover:text-white active:scale-[0.97] ' +
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-danger'
        }
      >
        <Trash size={14} weight="light" aria-hidden="true" />
        {p.delete}
      </button>
    </div>
  )
}
