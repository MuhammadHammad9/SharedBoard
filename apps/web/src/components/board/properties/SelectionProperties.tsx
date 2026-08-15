import { Trash } from '@phosphor-icons/react'
import {
  PEN_COLOURS,
  STROKE_WIDTH_MAX,
  STROKE_WIDTH_MIN,
  type BoardObject,
  type StrokeObject,
} from '@coboard/shared'
import { selectedObjects, useBoardStore } from '../../../stores/boardStore.js'
import { ColorSwatch } from '../../ui/ColorSwatch.js'
import { Slider } from '../../ui/Slider.js'
import { MIXED, MixedValue, commonValue } from './MixedValue.js'

/**
 * Properties for the current selection — FLOWS §14.4.
 *
 * The table in §14.4 has three multi-selection rows: same type shows the
 * shared property set, mixed types show only universally shared properties,
 * and differing values render as "Mixed". All three fall out of one rule —
 * offer a control when EVERY selected object has that property, and show
 * "Mixed" when they disagree on its value — so there is no per-combination
 * branching to get wrong as Phase 5 adds types.
 *
 * PHASE 5/6 SLOTS: z-order controls (§14.4 lists them for every selection row)
 * need `FR-CANVAS-016`'s reordering, and Delete becomes undoable when Phase 6
 * lands. Both are noted at their call sites.
 *
 * R-ARCH-003: this component subscribes to the selection ARRAY and the object
 * VERSION, never to the object Map. It re-renders when the selection changes
 * and when a transform commits — a few times a second at most, not sixty.
 */

/** Every selected object carries a stroke colour and width. */
const isStrokeLike = (o: BoardObject): o is StrokeObject => o.type === 'stroke'

export function SelectionProperties() {
  const selectionCount = useBoardStore(s => s.selection.length)
  // Reading the version rather than the objects themselves keeps the
  // subscription narrow while still refreshing after a transform commits.
  useBoardStore(s => s.objectsVersion)
  const updateObjects = useBoardStore(s => s.updateObjects)
  const deleteObjects = useBoardStore(s => s.deleteObjects)
  const selection = useBoardStore(s => s.selection)

  const objects = selectedObjects()
  if (objects.length === 0) return null

  const allStrokes = objects.every(isStrokeLike)
  const strokes = objects.filter(isStrokeLike)

  const colour = allStrokes ? commonValue(strokes, o => o.color) : undefined
  const width = allStrokes ? commonValue(strokes, o => o.strokeWidth) : undefined
  // Opacity is on BaseObject, so it is the one property every type shares —
  // the "universally shared" row of §14.4.
  const opacity = commonValue(objects, o => o.opacity)

  const patch = (fn: (o: BoardObject) => BoardObject) => updateObjects(objects.map(fn))

  return (
    <div className="flex flex-col gap-4" data-testid="selection-properties">
      <header className="flex items-baseline justify-between">
        <h3 className="text-xs font-medium text-muted">
          {selectionCount === 1 ? '1 object' : `${selectionCount} objects`}
        </h3>
      </header>

      {allStrokes && (
        <section className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <h4 className="text-xs font-medium text-muted">Colour</h4>
            {colour === MIXED && <MixedValue />}
          </div>
          <div className="grid grid-cols-5 gap-2" role="group" aria-label="Stroke colour">
            {PEN_COLOURS.map(c => (
              <ColorSwatch
                key={c}
                color={c}
                selected={colour !== MIXED && colour === c}
                onSelect={next =>
                  patch(o =>
                    isStrokeLike(o) ? { ...o, color: next, updatedAt: Date.now() } : o,
                  )
                }
              />
            ))}
          </div>
        </section>
      )}

      {/*
        The sliders carry "Mixed" in their own value readout rather than
        stacking a separate label above them. The thumb still has to sit
        somewhere, so it falls back to the minimum — moving it then applies one
        definite value to the whole selection, which is what the user means by
        touching it.
      */}
      {allStrokes && (
        <Slider
          label="Width"
          value={width === MIXED || width === undefined ? STROKE_WIDTH_MIN : width}
          min={STROKE_WIDTH_MIN}
          max={STROKE_WIDTH_MAX}
          display={width === MIXED ? 'Mixed' : `${width ?? STROKE_WIDTH_MIN} px`}
          mixed={width === MIXED}
          testId="selection-width-slider"
          onChange={next =>
            patch(o =>
              isStrokeLike(o) ? { ...o, strokeWidth: next, updatedAt: Date.now() } : o,
            )
          }
        />
      )}

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
        onChange={next =>
          patch(o => ({ ...o, opacity: next / 100, updatedAt: Date.now() }))
        }
      />

      {/* PHASE 5 SLOT: z-order controls (§14.4) once FR-CANVAS-016 exists. */}

      <button
        type="button"
        // FR-CANVAS-014. PHASE 6 SLOT: this becomes undoable when
        // HistoryManager lands; deleteObjects is already the single hook.
        onClick={() => deleteObjects(selection)}
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
