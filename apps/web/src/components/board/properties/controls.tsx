import {
  ArrowDown,
  ArrowLineDown,
  ArrowLineUp,
  ArrowUp,
  ArrowLeft,
  ArrowRight,
  ArrowsHorizontal,
  Minus,
} from '@phosphor-icons/react'
import { FONT_SIZE_MAX, FONT_SIZE_MIN } from '@coboard/shared'
import { Slider } from '../../ui/Slider.js'
import { boardChrome } from '../../../lib/strings.js'
import { ARROWHEADS, type Arrowheads } from '../../../features/canvas/arrowheads.js'
import {
  bringForward,
  bringToFront,
  sendBackward,
  sendToBack,
} from '../../../features/canvas/interaction/handlers/clipboardActions.js'

const p = boardChrome.properties
const menu = boardChrome.contextMenu

/**
 * Small controls shared by the tool and selection contexts of the properties
 * panel — FLOWS §14.4. Board chrome: no motion beyond the press feedback
 * (R-MOTION-001 — these are clicked many times a day).
 */

const TOGGLE =
  'flex h-8 flex-1 cursor-pointer items-center justify-center rounded-sm ' +
  'transition-colors duration-fast ease-standard active:scale-[0.97] ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent'

export const toggleClass = (active: boolean) =>
  `${TOGGLE} ${active ? 'bg-accent/10 text-accent ring-1 ring-accent' : 'text-primary hover:bg-subtle'}`

const ARROWHEAD_UI: Record<Arrowheads, { label: string; Icon: typeof Minus }> = {
  none: { label: p.arrowheadNone, Icon: Minus },
  start: { label: p.arrowheadStart, Icon: ArrowLeft },
  end: { label: p.arrowheadEnd, Icon: ArrowRight },
  both: { label: p.arrowheadBoth, Icon: ArrowsHorizontal },
}

/** "Arrowhead style (start/end/both/none)". `value` undefined = Mixed. */
export function ArrowheadControl({
  value,
  onChange,
}: {
  value: Arrowheads | undefined
  onChange: (next: Arrowheads) => void
}) {
  return (
    <section className="flex flex-col gap-2">
      <h4 className="text-xs font-medium text-muted">{p.arrowheads}</h4>
      <div className="flex gap-1" role="group" aria-label={p.arrowheads}>
        {ARROWHEADS.map(style => {
          const { label, Icon } = ARROWHEAD_UI[style]
          return (
            <button
              key={style}
              type="button"
              aria-label={label}
              aria-pressed={value === style}
              data-testid={`arrowheads-${style}`}
              onClick={() => onChange(style)}
              className={toggleClass(value === style)}
            >
              <Icon size={16} weight="light" aria-hidden="true" />
            </button>
          )
        })}
      </div>
    </section>
  )
}

/**
 * Sticky font size — FLOWS §14.4 "font size auto/manual toggle". Auto is the
 * FR-CANVAS-008 auto-shrink (16 → 10 px); manual fixes a size in the schema's
 * 8–128 range. `value` undefined = Mixed.
 */
export function StickyFontControl({
  value,
  onChange,
}: {
  value: number | 'auto' | undefined
  onChange: (next: number | 'auto') => void
}) {
  const auto = value === 'auto'
  const manual = typeof value === 'number' ? value : 16
  return (
    <section className="flex flex-col gap-2">
      <h4 className="text-xs font-medium text-muted">{p.fontSize}</h4>
      <button
        type="button"
        aria-pressed={auto}
        aria-label={p.fontSizeAutoLabel}
        data-testid="sticky-font-auto"
        onClick={() => onChange(auto ? manual : 'auto')}
        className={toggleClass(auto)}
      >
        <span className="text-xs">{p.fontSizeAuto}</span>
      </button>
      {typeof value === 'number' && (
        <Slider
          label={p.fontSize}
          value={value}
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          display={`${value} px`}
          testId="sticky-font-slider"
          onChange={onChange}
        />
      )}
    </section>
  )
}

/**
 * Z-order — FR-CANVAS-016, FLOWS §14.4 "z-order controls". The same four
 * actions as the context menu and `[` `]`, so one implementation and one undo
 * entry each.
 */
export function LayerControls() {
  const buttons = [
    { label: menu.bringToFront, Icon: ArrowLineUp, run: bringToFront, id: 'front' },
    { label: menu.bringForward, Icon: ArrowUp, run: bringForward, id: 'forward' },
    { label: menu.sendBackward, Icon: ArrowDown, run: sendBackward, id: 'backward' },
    { label: menu.sendToBack, Icon: ArrowLineDown, run: sendToBack, id: 'back' },
  ]
  return (
    <section className="flex flex-col gap-2">
      <h4 className="text-xs font-medium text-muted">{p.layer}</h4>
      <div className="flex gap-1" role="group" aria-label={p.layer}>
        {buttons.map(({ label, Icon, run, id }) => (
          <button
            key={id}
            type="button"
            aria-label={label}
            title={label}
            data-testid={`layer-${id}`}
            onClick={run}
            className={toggleClass(false)}
          >
            <Icon size={16} weight="light" aria-hidden="true" />
          </button>
        ))}
      </div>
    </section>
  )
}
