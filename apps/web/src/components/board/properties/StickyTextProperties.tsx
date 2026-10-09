import {
  TextAa,
  TextAlignCenter,
  TextAlignLeft,
  TextAlignRight,
  TextB,
  TextItalic,
} from '@phosphor-icons/react'
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  PEN_COLOURS,
  STICKY_COLOURS,
} from '@coboard/shared'
import { useBoardStore } from '../../../stores/boardStore.js'
import { ColorSwatch } from '../../ui/ColorSwatch.js'
import { StickyFontControl } from './controls.js'
import { Slider } from '../../ui/Slider.js'
import { boardChrome } from '../../../lib/strings.js'

const p = boardChrome.properties

/**
 * Sticky-note and text tool properties — FLOWS §14.4.
 *
 * "Sticky — 8 colour swatches, font size auto/manual toggle"
 * "Text — font size, colour, bold, italic, alignment"
 */

const ALIGNMENTS = [
  { value: 'left' as const, icon: TextAlignLeft, label: p.alignLeft },
  { value: 'center' as const, icon: TextAlignCenter, label: p.alignCentre },
  { value: 'right' as const, icon: TextAlignRight, label: p.alignRight },
]

const TOGGLE =
  'flex h-8 flex-1 cursor-pointer items-center justify-center rounded-sm ' +
  'transition-colors duration-fast ease-standard active:scale-[0.97] ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent'

const on = (active: boolean) =>
  `${TOGGLE} ${active ? 'bg-accent/10 text-accent ring-1 ring-accent' : 'text-primary hover:bg-subtle'}`

export function StickyProperties() {
  const sticky = useBoardStore(s => s.sticky)
  const setSticky = useBoardStore(s => s.setSticky)

  return (
    <div className="flex flex-col gap-4" data-testid="sticky-properties">
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-muted">{p.colour}</h3>
        {/*
          The 8 FROZEN sticky colours — R-UI-014. A sticky's colour is a
          persisted object property, so this palette is not a styling choice
          and cannot be extended without changing stored data.
        */}
        <div className="grid grid-cols-4 gap-2" role="group" aria-label={p.stickyColour}>
          {Object.entries(STICKY_COLOURS).map(([name, value]) => (
            <ColorSwatch
              key={value}
              color={value}
              name={name}
              selected={sticky.color.toLowerCase() === value.toLowerCase()}
              onSelect={color => setSticky({ color })}
            />
          ))}
        </div>
      </section>

      <StickyFontControl
        value={sticky.fontSize}
        onChange={fontSize => setSticky({ fontSize })}
      />

      <p className="text-xs text-muted">{p.stickyHint}</p>
    </div>
  )
}

export function TextProperties() {
  const text = useBoardStore(s => s.text)
  const setText = useBoardStore(s => s.setText)

  return (
    <div className="flex flex-col gap-4" data-testid="text-properties">
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-muted">{p.colour}</h3>
        <div className="grid grid-cols-5 gap-2" role="group" aria-label={p.textColour}>
          {PEN_COLOURS.map(c => (
            <ColorSwatch
              key={c}
              color={c}
              selected={text.color.toLowerCase() === c.toLowerCase()}
              onSelect={color => setText({ color })}
            />
          ))}
        </div>
      </section>

      <Slider
        label={p.fontSize}
        value={text.fontSize}
        min={FONT_SIZE_MIN}
        max={FONT_SIZE_MAX}
        display={`${text.fontSize} px`}
        testId="text-size-slider"
        onChange={fontSize => setText({ fontSize })}
      />

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-muted">{p.style}</h3>
        <div className="flex gap-1" role="group" aria-label={p.textStyle}>
          <button
            type="button"
            aria-label={p.bold}
            aria-pressed={text.bold}
            data-testid="text-bold"
            onClick={() => setText({ bold: !text.bold })}
            className={on(text.bold)}
          >
            <TextB size={16} weight="light" aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={p.italic}
            aria-pressed={text.italic}
            data-testid="text-italic"
            onClick={() => setText({ italic: !text.italic })}
            className={on(text.italic)}
          >
            <TextItalic size={16} weight="light" aria-hidden="true" />
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-muted">{p.alignment}</h3>
        <div className="flex gap-1" role="group" aria-label={p.textAlignment}>
          {ALIGNMENTS.map(({ value, icon: Icon, label }) => (
            <button
              key={value}
              type="button"
              aria-label={label}
              aria-pressed={text.textAlign === value}
              data-testid={`text-align-${value}`}
              onClick={() => setText({ textAlign: value })}
              className={on(text.textAlign === value)}
            >
              <Icon size={16} weight="light" aria-hidden="true" />
            </button>
          ))}
        </div>
      </section>

      <p className="flex items-center gap-2 text-xs text-muted">
        <TextAa size={14} weight="light" aria-hidden="true" />
        {p.textHint}
      </p>
    </div>
  )
}
