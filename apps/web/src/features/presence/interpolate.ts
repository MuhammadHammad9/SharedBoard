import { CURSOR_FADE_MS, CURSOR_HIDE_MS, CURSOR_INTERPOLATE_MS } from '@coboard/shared'

/**
 * Cursor smoothing — TRD §10.4, FLOWS §9.2.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  THIS IS NOT AN ANIMATION. It is data reconstruction.                    │
 * │                                                                          │
 * │  The wire carries 20 samples a second; the display runs at 60. Drawing   │
 * │  the raw samples means each cursor teleports three frames' worth of      │
 * │  distance and then sits still twice — which reads as a broken connection │
 * │  rather than as a person moving a mouse.                                 │
 * │                                                                          │
 * │  So it is exempt from the R-MOTION-001 frequency gate, which governs     │
 * │  animating STATE CHANGES. Nothing is being animated here: the missing    │
 * │  frames between two samples are being filled in. `linear`, because       │
 * │  easing between samples of continuous motion would add a wobble that     │
 * │  was never in the original.                                              │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

export interface RemoteCursor {
  sessionId: string
  /** The latest reported position, in CANVAS coordinates. */
  x: number
  y: number
  /** Where it was before, so the gap can be filled. */
  prevX: number
  prevY: number
  /** Epoch ms the latest position arrived. */
  updatedAt: number
}

export interface InterpolatedCursor {
  x: number
  y: number
  /** 1 normally, 0.4 when idle 5 s, 0 when idle 15 s — FLOWS §9.2. */
  opacity: number
}

export function interpolateCursor(
  cursor: RemoteCursor,
  now: number,
  intervalMs: number = CURSOR_INTERPOLATE_MS,
): InterpolatedCursor {
  const t = Math.min(Math.max((now - cursor.updatedAt) / intervalMs, 0), 1)

  return {
    x: cursor.prevX + (cursor.x - cursor.prevX) * t,
    y: cursor.prevY + (cursor.y - cursor.prevY) * t,
    opacity: idleOpacity(now - cursor.updatedAt),
  }
}

/**
 * Fade at 5 s, hide at 15 s — FLOWS §9.2.
 *
 * The avatar stays in the header either way. A cursor parked in the middle of
 * the board by someone who wandered off is visual noise that the reader has to
 * keep dismissing mentally; their presence in the room is still worth showing,
 * and the header is where that belongs.
 *
 * The transition between the two states is a 300 ms ramp rather than a step,
 * because a cursor that snaps from 100% to 40% opacity reads as a glitch.
 */
export function idleOpacity(idleMs: number): number {
  if (idleMs >= CURSOR_HIDE_MS) return 0
  if (idleMs >= CURSOR_FADE_MS) {
    // Ramp 1 → 0.4 over the 300 ms after the fade threshold, then hold, then
    // ramp 0.4 → 0 over the 300 ms after the hide threshold.
    const intoFade = Math.min((idleMs - CURSOR_FADE_MS) / 300, 1)
    const faded = 1 - 0.6 * intoFade
    const untilHide = CURSOR_HIDE_MS - idleMs
    if (untilHide < 300) return faded * (untilHide / 300)
    return faded
  }
  return 1
}
