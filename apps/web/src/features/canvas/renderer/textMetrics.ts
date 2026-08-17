/**
 * Text measurement and wrapping — FR-CANVAS-008, FR-CANVAS-009.
 *
 * Shared by the sticky-note and text renderers, and by the DOM overlay that
 * sits on top of them: the overlay's line breaks must match the canvas's
 * exactly, or the text visibly jumps the instant editing ends.
 *
 * Every function here takes a `measure` callback rather than a canvas context.
 * That keeps the wrapping algorithm pure and unit-testable in the `node`
 * environment — the renderer passes `s => ctx.measureText(s).width`, and a
 * test passes a deterministic stub. Wrapping is where the bugs are; measuring
 * is not.
 */

export type MeasureText = (text: string) => number

/** PRD §15 mandates Inter. Canvas needs the full shorthand, not a class. */
export const FONT_STACK = 'Inter, system-ui, -apple-system, sans-serif'

export const fontString = (size: number, bold = false, italic = false): string =>
  `${italic ? 'italic ' : ''}${bold ? '600 ' : ''}${size}px ${FONT_STACK}`

/** Canvas has no line-height concept; this is the multiplier both sides use. */
export const LINE_HEIGHT_RATIO = 1.35

export const lineHeightFor = (fontSize: number): number => fontSize * LINE_HEIGHT_RATIO

/**
 * Wrap text to a maximum width.
 *
 * Breaks on whitespace, and preserves the user's own newlines — a sticky note
 * with deliberate line breaks must keep them. A single word longer than the
 * line is broken character by character rather than allowed to overflow,
 * because a URL pasted into a note should stay inside the note.
 */
export function wrapText(text: string, maxWidth: number, measure: MeasureText): string[] {
  if (text === '') return ['']
  if (maxWidth <= 0) return text.split('\n')

  const out: string[] = []

  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      // A blank line is a line. Collapsing it would silently eat the user's
      // paragraph breaks.
      out.push('')
      continue
    }

    let line = ''
    for (const word of paragraph.split(' ')) {
      const candidate = line === '' ? word : `${line} ${word}`

      if (measure(candidate) <= maxWidth) {
        line = candidate
        continue
      }

      if (line !== '') {
        out.push(line)
        line = ''
      }

      // The word alone may still not fit.
      if (measure(word) <= maxWidth) {
        line = word
        continue
      }

      let chunk = ''
      for (const char of word) {
        if (chunk !== '' && measure(chunk + char) > maxWidth) {
          out.push(chunk)
          chunk = char
        } else {
          chunk += char
        }
      }
      line = chunk
    }

    out.push(line)
  }

  return out
}

/** Sticky auto-shrink bounds — FR-CANVAS-008. */
export const STICKY_FONT_MAX = 16
export const STICKY_FONT_MIN = 10

export interface FitResult {
  fontSize: number
  lines: string[]
  /** True when even the minimum size overflows: the note scrolls internally. */
  overflows: boolean
}

/**
 * Largest font size from `max` down to `min` whose wrapped text fits the box —
 * FR-CANVAS-008's "auto-shrink from 16 px down to 10 px to fit".
 *
 * Steps down by whole pixels rather than binary-searching. The range is only
 * seven values, and monotonicity is not actually guaranteed with kerning and
 * hinting, so a linear walk from the top is both simpler and more correct than
 * a search that assumes a property the font does not promise.
 *
 * When even `min` overflows, the smallest size is returned with
 * `overflows: true` — the note then scrolls internally behind a fade
 * indicator rather than spilling text across the board.
 */
export function fitText(
  text: string,
  maxWidth: number,
  maxHeight: number,
  measureAt: (size: number) => MeasureText,
  max = STICKY_FONT_MAX,
  min = STICKY_FONT_MIN,
): FitResult {
  let smallest: FitResult | null = null

  for (let size = max; size >= min; size--) {
    const lines = wrapText(text, maxWidth, measureAt(size))
    const height = lines.length * lineHeightFor(size)
    const candidate: FitResult = { fontSize: size, lines, overflows: false }
    if (height <= maxHeight) return candidate
    smallest = candidate
  }

  return smallest
    ? { ...smallest, overflows: true }
    : { fontSize: min, lines: wrapText(text, maxWidth, measureAt(min)), overflows: true }
}

/** Padding between a sticky note's edge and its text, in canvas units. */
export const STICKY_PADDING = 12
