import type { StickyObject, TextObject } from '@coboard/shared'
import {
  STICKY_PADDING,
  fitText,
  fontString,
  lineHeightFor,
  wrapText,
  type MeasureText,
} from '../textMetrics.js'

/**
 * Sticky-note and text renderers — FR-CANVAS-008, FR-CANVAS-009.
 *
 * Both draw the text that the DOM overlay is editing, live and underneath it
 * (FLOWS §8.2.2 step 3). The overlay is transparent, so what the user sees
 * while typing is THIS output — which is why the wrapping here and the
 * overlay's own wrapping must agree exactly, and why both go through
 * `textMetrics`.
 */

/** PRD §15 tokens. A canvas cannot read a CSS custom property. */
const TEXT_PRIMARY = '#18181B'
const BORDER = '#E4E4E7'

const measureWith = (ctx: CanvasRenderingContext2D, font: string): MeasureText => {
  ctx.font = font
  return (s: string) => ctx.measureText(s).width
}

/** Horizontal draw position for a line, given the alignment. */
function alignX(
  align: 'left' | 'center' | 'right',
  boxX: number,
  boxWidth: number,
  padding: number,
): number {
  switch (align) {
    case 'center':
      return boxX + boxWidth / 2
    case 'right':
      return boxX + boxWidth - padding
    default:
      return boxX + padding
  }
}

const canvasAlign = (align: 'left' | 'center' | 'right'): CanvasTextAlign =>
  align === 'center' ? 'center' : align === 'right' ? 'right' : 'left'

/**
 * A sticky note: a filled rounded square with auto-shrinking, centred text.
 *
 * FR-CANVAS-008 — "text auto-shrinks from 16 px down to 10 px to fit; beyond
 * that the note scrolls internally and shows a fade indicator", and "text is
 * centred vertically and horizontally by default".
 */
export function drawSticky(ctx: CanvasRenderingContext2D, s: StickyObject): void {
  ctx.save()
  ctx.globalAlpha = s.opacity

  // The note itself. A hairline border keeps a pale note legible against the
  // #FAFAFA canvas — without it, the grey sticky nearly disappears.
  ctx.fillStyle = s.color
  ctx.beginPath()
  ctx.roundRect(s.x, s.y, s.width, s.height, 4)
  ctx.fill()
  ctx.strokeStyle = BORDER
  ctx.lineWidth = 1
  ctx.stroke()

  if (s.text !== '') {
    const innerWidth = Math.max(0, s.width - STICKY_PADDING * 2)
    const innerHeight = Math.max(0, s.height - STICKY_PADDING * 2)

    const fitted =
      s.fontSize === 'auto'
        ? fitText(s.text, innerWidth, innerHeight, size =>
            measureWith(ctx, fontString(size)),
          )
        : {
            fontSize: s.fontSize,
            lines: wrapText(s.text, innerWidth, measureWith(ctx, fontString(s.fontSize))),
            overflows: false,
          }

    const lineHeight = lineHeightFor(fitted.fontSize)
    const textHeight = fitted.lines.length * lineHeight

    ctx.save()
    // Overflowing text is clipped to the note rather than spilling across the
    // board. The fade below tells the user there is more.
    ctx.beginPath()
    ctx.rect(s.x, s.y, s.width, s.height)
    ctx.clip()

    ctx.font = fontString(fitted.fontSize)
    ctx.fillStyle = TEXT_PRIMARY
    ctx.textAlign = canvasAlign(s.textAlign)
    ctx.textBaseline = 'middle'

    // Vertically centred, or top-aligned once it no longer fits — centring
    // overflowing text hides the beginning as well as the end.
    const startY = fitted.overflows
      ? s.y + STICKY_PADDING + lineHeight / 2
      : s.y + s.height / 2 - textHeight / 2 + lineHeight / 2

    const x = alignX(s.textAlign, s.x, s.width, STICKY_PADDING)
    for (let i = 0; i < fitted.lines.length; i++) {
      ctx.fillText(fitted.lines[i]!, x, startY + i * lineHeight)
    }

    if (fitted.overflows) {
      // The fade indicator. A gradient from transparent to the note's own
      // colour, so the text appears to dissolve into the paper.
      const fadeHeight = Math.min(24, s.height / 3)
      const gradient = ctx.createLinearGradient(
        0,
        s.y + s.height - fadeHeight,
        0,
        s.y + s.height,
      )
      gradient.addColorStop(0, `${s.color}00`)
      gradient.addColorStop(1, s.color)
      ctx.fillStyle = gradient
      ctx.fillRect(s.x, s.y + s.height - fadeHeight, s.width, fadeHeight)
    }

    ctx.restore()
  }

  ctx.restore()
}

/**
 * A free text object — FR-CANVAS-009.
 *
 * No background and no border: text on a whiteboard is ink, not a box. Its
 * bounding box exists for selection and hit testing only.
 */
export function drawText(ctx: CanvasRenderingContext2D, t: TextObject): void {
  if (t.text === '') return

  ctx.save()
  ctx.globalAlpha = t.opacity
  ctx.font = fontString(t.fontSize, t.bold, t.italic)
  ctx.fillStyle = t.color
  ctx.textAlign = canvasAlign(t.textAlign)
  ctx.textBaseline = 'middle'

  const lines = wrapText(
    t.text,
    t.width,
    measureWith(ctx, fontString(t.fontSize, t.bold, t.italic)),
  )
  const lineHeight = lineHeightFor(t.fontSize)
  const x = alignX(t.textAlign, t.x, t.width, 0)

  // Top-anchored: a text object grows downward as the user types, so anchoring
  // to the vertical centre would make every keystroke shift the existing text.
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i]!, x, t.y + lineHeight / 2 + i * lineHeight)
  }

  ctx.restore()
}

/** Measured height of a text object's wrapped content, for box auto-sizing. */
export function textHeightFor(
  ctx: CanvasRenderingContext2D,
  t: Pick<TextObject, 'text' | 'width' | 'fontSize' | 'bold' | 'italic'>,
): number {
  const font = fontString(t.fontSize, t.bold, t.italic)
  const lines = wrapText(t.text, t.width, measureWith(ctx, font))
  return Math.max(1, lines.length) * lineHeightFor(t.fontSize)
}
