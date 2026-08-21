import type { Rect, Viewport } from '@coboard/shared'
import { interpolateCursor, type RemoteCursor } from './interpolate.js'
import type { RemoteStroke } from './presenceStore.js'

/**
 * Presence pixels — LAYER 3 ONLY. FLOWS §9.2, §14.3.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  R-CANVAS-002 (Blocking) — the rule this whole phase is shaped around.   │
 * │                                                                          │
 * │  A remote cursor must never redraw layer 1. Ten people moving pointers   │
 * │  at 20 Hz is 200 repaints a second; if any of them touched the object    │
 * │  layer, a board with 5,000 objects would drop to single-figure frame     │
 * │  rates for everyone in the room — and the person whose frame rate died   │
 * │  would have done nothing but watch.                                      │
 * │                                                                          │
 * │  Nothing in this file has any way to reach layer 1. The proof is a test  │
 * │  that reads `objectPaints` before and after moving a cursor and asserts  │
 * │  it did not move.                                                        │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Drawn UNTRANSFORMED and positioned by hand, like the selection overlay:
 * applying the viewport transform would scale the cursor arrow and the name
 * pill with the zoom, giving specks at 10% and billboards at 500%.
 *
 * MOTION: none, except the interpolation the caller has already applied to the
 * position. No entrance animation on a cursor appearing, no pulse, no trail.
 */

const WHITE = '#FFFFFF'
/** Cursor arrow, in screen px. Matches a native pointer closely enough. */
const ARROW: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0, 16],
  [4.2, 12.2],
  [6.8, 17.6],
  [9.4, 16.4],
  [6.8, 11.2],
  [12, 11.2],
]

export interface PresenceView {
  cursors: ReadonlyArray<RemoteCursor & { name: string; colour: string }>
  selections: ReadonlyArray<{ box: Rect; colour: string; name: string }>
  strokes: ReadonlyArray<RemoteStroke & { colour: string; strokeWidth: number }>
}

export interface DrawPresenceArgs {
  viewport: Viewport
  now: number
  view: PresenceView
}

export function drawPresence(
  ctx: CanvasRenderingContext2D,
  { viewport, now, view }: DrawPresenceArgs,
): void {
  const sx = (x: number) => x * viewport.zoom + viewport.x
  const sy = (y: number) => y * viewport.zoom + viewport.y

  /*
   * Remote in-progress strokes first, so they sit UNDER the cursors and
   * selection outlines. A cursor hidden behind the line it is drawing is the
   * one element here that must always stay on top — it is what tells you who
   * is doing it.
   */
  for (const stroke of view.strokes) {
    if (stroke.points.length < 6) continue
    ctx.save()
    ctx.strokeStyle = stroke.colour
    ctx.lineWidth = Math.max(1, stroke.strokeWidth * viewport.zoom)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    // Slightly translucent: it is a preview of an op that has not committed,
    // and it should not be indistinguishable from a real object.
    ctx.globalAlpha = 0.85
    ctx.beginPath()
    ctx.moveTo(sx(stroke.points[0]!), sy(stroke.points[1]!))
    for (let i = 3; i + 1 < stroke.points.length; i += 3) {
      ctx.lineTo(sx(stroke.points[i]!), sy(stroke.points[i + 1]!))
    }
    ctx.stroke()
    ctx.restore()
  }

  // Remote selection outlines — FR-RT-005. Instant, no animation.
  for (const selection of view.selections) {
    ctx.save()
    ctx.strokeStyle = selection.colour
    ctx.lineWidth = 1
    // Dashed, so it is distinguishable from YOUR OWN solid selection box at a
    // glance — colour alone would fail for anyone who cannot separate two
    // hues (R-A11Y-007).
    ctx.setLineDash([4, 3])
    ctx.strokeRect(
      Math.round(sx(selection.box.x)) + 0.5,
      Math.round(sy(selection.box.y)) + 0.5,
      Math.round(selection.box.width * viewport.zoom),
      Math.round(selection.box.height * viewport.zoom),
    )
    ctx.restore()
  }

  for (const cursor of view.cursors) {
    const { x, y, opacity } = interpolateCursor(cursor, now)
    // Hidden after 15 s idle. The avatar stays in the header.
    if (opacity <= 0.01) continue

    const px = sx(x)
    const py = sy(y)

    ctx.save()
    ctx.globalAlpha = opacity
    ctx.translate(px, py)

    // The arrow: filled in the user's colour, outlined in white so it stays
    // legible over a dark stroke or a saturated sticky.
    ctx.beginPath()
    ctx.moveTo(ARROW[0]![0], ARROW[0]![1])
    for (const [ax, ay] of ARROW.slice(1)) ctx.lineTo(ax, ay)
    ctx.closePath()
    ctx.fillStyle = cursor.colour
    ctx.fill()
    ctx.strokeStyle = WHITE
    ctx.lineWidth = 1.5
    ctx.stroke()

    /*
     * The name pill — R-A11Y-007. Colour is NEVER the only indicator: with
     * twelve palette entries and any number of people, two users can look
     * similar to anyone, and identical to someone with a colour vision
     * deficiency. The name is what actually identifies them.
     */
    const label = cursor.name
    ctx.font = '11px Inter, system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    const padX = 6
    const textW = ctx.measureText(label).width
    const pillW = textW + padX * 2
    const pillH = 18
    const pillX = 14
    const pillY = 12

    ctx.fillStyle = cursor.colour
    ctx.beginPath()
    ctx.roundRect(pillX, pillY, pillW, pillH, 4)
    ctx.fill()

    ctx.fillStyle = WHITE
    ctx.fillText(label, pillX + padX, pillY + pillH / 2 + 0.5)

    ctx.restore()
  }
}

/** Truncate a display name for the pill — E-20. */
export const NAME_MAX = 20
export const truncateName = (name: string): string =>
  name.length <= NAME_MAX ? name : `${name.slice(0, NAME_MAX - 1)}…`
