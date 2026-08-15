import { useId } from 'react'

/**
 * A labelled range control.
 *
 * Built on the native `<input type="range">` on purpose. A div-with-a-thumb
 * would have to reimplement arrow-key stepping, Home/End, Page Up/Down, the
 * `slider` role, value announcement, high-contrast rendering and pointer
 * capture — and would get several of them subtly wrong. The native element has
 * all of it, and R-A11Y-003 requires all of it.
 *
 * The current value is shown as text beside the label, which is both a
 * usability win and the ui-ux-pro-max "Color Only" rule generalised: the thumb
 * position alone is not a readable value.
 */

export interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  /** Rendered next to the label, e.g. `3 px` or `80%`. Defaults to the value. */
  display?: string
  /**
   * The selection disagrees on this property (FLOWS §14.4). Styles the readout
   * as the "Mixed" marker and tags it for tests, so a multi-selection needs no
   * second label stacked above the slider.
   */
  mixed?: boolean
  onChange: (value: number) => void
  testId?: string
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  display,
  mixed = false,
  onChange,
  testId,
}: SliderProps) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="text-xs text-muted">
          {label}
        </label>
        <span
          className={
            mixed ? 'text-xs italic text-muted' : 'text-xs tabular-nums text-primary'
          }
          data-testid={mixed ? 'mixed-value' : undefined}
        >
          {display ?? value}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        data-testid={testId}
        onChange={e => onChange(Number(e.target.value))}
        className="h-1 w-full cursor-pointer appearance-none rounded-sm bg-border accent-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      />
    </div>
  )
}
