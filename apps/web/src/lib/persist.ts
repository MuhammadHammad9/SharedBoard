/**
 * Local preference persistence.
 *
 * R-STATE-005: the tool choice survives a refresh (FLOWS §8.2.1 step 1). The
 * pen's colour, thickness and opacity ride along, because a properties panel
 * that resets every reload is the same papercut one level down.
 *
 * Two rules govern everything here.
 *
 * 1. READS ARE NEVER TRUSTED. `localStorage` is user-writable and survives
 *    deploys, so a stored value may be stale, hand-edited, or from a future
 *    version of the app. Every field is validated against its live constraint
 *    and falls back to the default on any mismatch. An unvalidated read is how
 *    a junk string reaches the renderer as a `strokeStyle` — or how a NaN
 *    width blanks a layer (R-SEC-004's failure mode, arriving by the back
 *    door rather than over the wire).
 *
 * 2. WRITES NEVER THROW. Storage is absent in SSR, disabled in some privacy
 *    modes, and full at quota. None of those are reasons to break drawing.
 */

const KEY = 'coboard.prefs.v1'

export interface PersistedPrefs {
  activeTool: string
  pen: { color: string; strokeWidth: number; opacity: number }
}

function readRaw(): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    // Unavailable, blocked, or malformed JSON. Defaults are a fine answer.
    return null
  }
}

/**
 * Read preferences, validating every field against the caller's constraints.
 * Anything that does not pass is silently replaced by the default.
 */
export function loadPrefs(
  defaults: PersistedPrefs,
  isValidTool: (t: string) => boolean,
  bounds: { widthMin: number; widthMax: number },
): PersistedPrefs {
  const raw = readRaw()
  if (!raw || typeof raw !== 'object') return defaults
  const o = raw as Record<string, unknown>
  const pen = (typeof o.pen === 'object' && o.pen !== null ? o.pen : {}) as Record<string, unknown>

  const num = (v: unknown, min: number, max: number, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fallback

  return {
    activeTool:
      typeof o.activeTool === 'string' && isValidTool(o.activeTool)
        ? o.activeTool
        : defaults.activeTool,
    pen: {
      color:
        typeof pen.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(pen.color)
          ? pen.color
          : defaults.pen.color,
      strokeWidth: num(pen.strokeWidth, bounds.widthMin, bounds.widthMax, defaults.pen.strokeWidth),
      opacity: num(pen.opacity, 0.1, 1, defaults.pen.opacity),
    },
  }
}

export function savePrefs(prefs: PersistedPrefs): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(prefs))
  } catch {
    // Quota, private mode, or no storage at all. Preferences are a nicety.
  }
}

/** Exported for tests that need a clean slate. */
export const PREFS_KEY = KEY
