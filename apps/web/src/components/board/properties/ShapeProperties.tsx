import { PEN_COLOURS, STROKE_WIDTH_MAX, STROKE_WIDTH_MIN } from '@coboard/shared'
import { useBoardStore } from '../../../stores/boardStore.js'
import { ColorSwatch } from '../../ui/ColorSwatch.js'
import { Slider } from '../../ui/Slider.js'

/**
 * Shape tool properties — FLOWS §14.4:
 * "Rect / Ellipse — fill colour (+ 'none'), stroke colour, stroke width,
 *  opacity, corner radius (rect only)"
 * "Line / Arrow — stroke colour, width, opacity, arrowhead style"
 *
 * Rendered for whichever shape tool is active, with the rows that do not apply
 * to it omitted rather than disabled — a greyed-out corner-radius slider on
 * the line tool is a control the user has to learn to ignore.
 */

export function ShapeProperties() {
  const activeTool = useBoardStore(s => s.activeTool)
  const shape = useBoardStore(s => s.shape)
  const setShape = useBoardStore(s => s.setShape)

  const isRect = activeTool === 'rect'
  const isClosed = activeTool === 'rect' || activeTool === 'ellipse'

  return (
    <div className="flex flex-col gap-4" data-testid="shape-properties">
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-muted">Stroke</h3>
        <div className="grid grid-cols-5 gap-2" role="group" aria-label="Stroke colour">
          {PEN_COLOURS.map(c => (
            <ColorSwatch
              key={c}
              color={c}
              context="Stroke colour"
              selected={shape.stroke.toLowerCase() === c.toLowerCase()}
              onSelect={stroke => setShape({ stroke })}
            />
          ))}
        </div>
      </section>

      {isClosed && (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-muted">Fill</h3>
          <div className="grid grid-cols-5 gap-2" role="group" aria-label="Fill colour">
            {/*
              "None" is a first-class fill value, not the absence of one — an
              outlined rectangle is a different object from a filled one, and
              the user needs to be able to choose it explicitly.
            */}
            <button
              type="button"
              aria-label="Fill none"
              aria-pressed={shape.fill === 'none'}
              data-testid="fill-none"
              onClick={() => setShape({ fill: 'none' })}
              className={
                'relative flex h-6 w-6 cursor-pointer items-center justify-center rounded-sm ' +
                'bg-app transition-transform duration-fast ease-out active:scale-[0.97] ' +
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
                'focus-visible:outline-accent ' +
                (shape.fill === 'none'
                  ? 'ring-2 ring-accent ring-offset-2 ring-offset-app'
                  : 'ring-1 ring-border')
              }
            >
              {/* A diagonal bar: the universal "no fill" mark. */}
              <span
                className="absolute h-px w-5 rotate-45 bg-danger"
                aria-hidden="true"
              />
            </button>
            {PEN_COLOURS.slice(0, 9).map(c => (
              <ColorSwatch
                key={c}
                color={c}
                context="Fill colour"
                selected={shape.fill.toLowerCase() === c.toLowerCase()}
                onSelect={fill => setShape({ fill })}
              />
            ))}
          </div>
        </section>
      )}

      <Slider
        label="Stroke width"
        value={shape.strokeWidth}
        min={STROKE_WIDTH_MIN}
        max={STROKE_WIDTH_MAX}
        display={`${shape.strokeWidth} px`}
        testId="shape-width-slider"
        onChange={strokeWidth => setShape({ strokeWidth })}
      />

      {isRect && (
        <Slider
          label="Corner radius"
          value={shape.cornerRadius}
          min={0}
          max={64}
          display={`${shape.cornerRadius} px`}
          testId="shape-radius-slider"
          onChange={cornerRadius => setShape({ cornerRadius })}
        />
      )}

      <Slider
        label="Opacity"
        value={Math.round(shape.opacity * 100)}
        min={10}
        max={100}
        step={5}
        display={`${Math.round(shape.opacity * 100)}%`}
        testId="shape-opacity-slider"
        onChange={v => setShape({ opacity: v / 100 })}
      />
    </div>
  )
}
