import { PEN_COLOURS, STROKE_WIDTH_MAX, STROKE_WIDTH_MIN } from '@coboard/shared'
import { useBoardStore } from '../../../stores/boardStore.js'
import { ColorSwatch } from '../../ui/ColorSwatch.js'
import { Slider } from '../../ui/Slider.js'

/**
 * Pen context for the properties panel — FLOWS §14.4:
 * "Colour swatches (10 + custom), thickness (5 presets + slider), opacity slider".
 *
 * The five thickness presets exist because reaching for a precise value on a
 * slider is fussy and most users want one of a handful of weights. The slider
 * stays for the cases the presets miss, and the two are bound to the same
 * value so they never disagree.
 */

/** 1–24 px is STROKE_WIDTH_MIN..MAX; these five span it usefully. */
const WIDTH_PRESETS = [1, 3, 6, 12, 24] as const

export function PenProperties() {
  // Narrow selectors — R-ARCH-003.
  const pen = useBoardStore(s => s.pen)
  const setPen = useBoardStore(s => s.setPen)

  return (
    <div className="flex flex-col gap-4" data-testid="pen-properties">
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-muted">Colour</h3>
        <div className="grid grid-cols-5 gap-2" role="group" aria-label="Pen colour">
          {PEN_COLOURS.map(c => (
            <ColorSwatch
              key={c}
              color={c}
              selected={pen.color.toLowerCase() === c.toLowerCase()}
              onSelect={color => setPen({ color })}
            />
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-muted">
          {/*
            The "+ custom" of FLOWS §14.4. A native colour input rather than a
            hand-built picker: it brings the OS picker, eyedropper and recent
            colours for free, and every one of those would otherwise be weeks.
          */}
          <input
            type="color"
            value={pen.color}
            aria-label="Custom pen colour"
            data-testid="pen-custom-colour"
            onChange={e => setPen({ color: e.target.value })}
            className="h-6 w-6 cursor-pointer rounded-sm border border-border bg-app p-0"
          />
          Custom
        </label>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-muted">Thickness</h3>
        <div className="flex items-center gap-1" role="group" aria-label="Thickness presets">
          {WIDTH_PRESETS.map(w => (
            <button
              key={w}
              type="button"
              aria-label={`Thickness ${w} pixels`}
              aria-pressed={pen.strokeWidth === w}
              data-testid={`pen-width-${w}`}
              onClick={() => setPen({ strokeWidth: w })}
              className={
                'flex h-8 flex-1 cursor-pointer items-center justify-center rounded-sm ' +
                'transition-colors duration-fast ease-standard active:scale-[0.97] ' +
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ' +
                (pen.strokeWidth === w ? 'bg-accent/10 ring-1 ring-accent' : 'hover:bg-subtle')
              }
            >
              {/* A dot at the real diameter — the preview IS the value. */}
              <span
                aria-hidden="true"
                className="rounded-full bg-primary"
                style={{ width: Math.min(w, 16), height: Math.min(w, 16) }}
              />
            </button>
          ))}
        </div>
        <Slider
          label="Width"
          value={pen.strokeWidth}
          min={STROKE_WIDTH_MIN}
          max={STROKE_WIDTH_MAX}
          display={`${pen.strokeWidth} px`}
          testId="pen-width-slider"
          onChange={strokeWidth => setPen({ strokeWidth })}
        />
      </section>

      <Slider
        label="Opacity"
        // FLOWS §14.4 gives opacity a 10–100% range: a 0% pen draws an
        // invisible object the user cannot then find to delete.
        value={Math.round(pen.opacity * 100)}
        min={10}
        max={100}
        step={5}
        display={`${Math.round(pen.opacity * 100)}%`}
        testId="pen-opacity-slider"
        onChange={v => setPen({ opacity: v / 100 })}
      />
    </div>
  )
}
