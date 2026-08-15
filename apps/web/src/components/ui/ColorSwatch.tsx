import { Check } from '@phosphor-icons/react'

/**
 * A single selectable colour.
 *
 * R-A11Y-004 / ui-ux-pro-max "Color Only" (severity High): **never convey
 * state by colour alone.** A colour swatch is the one control where that
 * mistake is easiest to make and worst to live with — if "selected" were only
 * a tint change, a user with a colour vision deficiency could not tell which
 * pen they are holding. Selection therefore carries three independent signals:
 * a ring, a check glyph, and `aria-pressed`.
 *
 * The check is drawn in black or white depending on the swatch's own
 * luminance, because a white tick on #EAB308 yellow fails contrast outright.
 *
 * R-MOTION-033: scale(0.97) on press. No hover scale — R-MOTION-001 puts
 * picking a colour in the "reduce" band, and eleven swatches that all grow
 * under the pointer is fidgety.
 */

export interface ColorSwatchProps {
  color: string
  selected: boolean
  onSelect: (color: string) => void
  /** Human-readable name for the accessible label. Falls back to the hex. */
  name?: string
}

/**
 * Relative luminance, WCAG 2.1 §1.4.3. Used to pick a tick colour that stays
 * legible on both #18181B and #EAB308.
 */
export function isLight(hex: string): boolean {
  const n = Number.parseInt(hex.slice(1), 16)
  if (!Number.isFinite(n)) return true
  const channel = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const r = channel((n >> 16) & 0xff)
  const g = channel((n >> 8) & 0xff)
  const b = channel(n & 0xff)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4
}

export function ColorSwatch({ color, selected, onSelect, name }: ColorSwatchProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={name ? `Colour ${name}` : `Colour ${color}`}
      data-testid={`swatch-${color.toLowerCase()}`}
      onClick={() => onSelect(color)}
      className={
        'flex h-6 w-6 cursor-pointer items-center justify-center rounded-sm ' +
        'transition-transform duration-fast ease-out active:scale-[0.97] ' +
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
        'focus-visible:outline-accent ' +
        (selected ? 'ring-2 ring-accent ring-offset-2 ring-offset-app' : 'ring-1 ring-border')
      }
      // R-UI-002 forbids arbitrary colour values in classes. This is DATA — one
      // of the ten frozen PEN_COLOURS, rendered as itself — not a styling
      // choice, so it belongs in an inline style rather than a Tailwind class.
      style={{ backgroundColor: color }}
    >
      {selected && (
        <Check
          size={14}
          weight="bold"
          aria-hidden="true"
          color={isLight(color) ? '#18181B' : '#FFFFFF'}
        />
      )}
    </button>
  )
}
