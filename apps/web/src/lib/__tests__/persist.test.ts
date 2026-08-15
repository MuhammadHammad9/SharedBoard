import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PREFS_KEY, loadPrefs, savePrefs, type PersistedPrefs } from '../persist.js'

/**
 * Preference persistence — R-STATE-005.
 *
 * The point of this suite is the untrusted-input half. `localStorage` is
 * user-writable and survives deploys, so every one of these malformed values
 * is something a real browser can hand us.
 */

const DEFAULTS: PersistedPrefs = {
  activeTool: 'select',
  pen: { color: '#18181B', strokeWidth: 3, opacity: 1 },
}

const VALID_TOOLS = ['select', 'hand', 'pen']
const isValidTool = (t: string) => VALID_TOOLS.includes(t)
const BOUNDS = { widthMin: 1, widthMax: 24 }

const load = () => loadPrefs(DEFAULTS, isValidTool, BOUNDS)

/** Minimal in-memory Storage. */
function memoryStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('round trip', () => {
  it('saves and restores a full preference set', () => {
    const prefs: PersistedPrefs = {
      activeTool: 'pen',
      pen: { color: '#EF4444', strokeWidth: 12, opacity: 0.5 },
    }
    savePrefs(prefs)
    expect(load()).toEqual(prefs)
  })

  it('returns the defaults when nothing has been stored', () => {
    expect(load()).toEqual(DEFAULTS)
  })
})

describe('untrusted input', () => {
  const store = (value: string) => globalThis.localStorage.setItem(PREFS_KEY, value)

  it('falls back on malformed JSON', () => {
    store('{ not json')
    expect(load()).toEqual(DEFAULTS)
  })

  it('falls back on a non-object payload', () => {
    store('"a string"')
    expect(load()).toEqual(DEFAULTS)
    store('42')
    expect(load()).toEqual(DEFAULTS)
    store('null')
    expect(load()).toEqual(DEFAULTS)
  })

  it('rejects a tool that does not exist', () => {
    // Also covers the real, benign case: a tool persisted by a later version
    // of the app, then a rollback.
    store(JSON.stringify({ activeTool: 'sticky', pen: DEFAULTS.pen }))
    expect(load().activeTool).toBe('select')
  })

  it('rejects a colour that is not a #RRGGBB hex', () => {
    for (const bad of ['red', '#fff', 'javascript:alert(1)', '#12345g', '']) {
      store(JSON.stringify({ activeTool: 'pen', pen: { ...DEFAULTS.pen, color: bad } }))
      expect(load().pen.color).toBe(DEFAULTS.pen.color)
    }
  })

  it('rejects a stroke width outside its bounds', () => {
    for (const bad of [0, -5, 25, 1e9]) {
      store(
        JSON.stringify({ activeTool: 'pen', pen: { ...DEFAULTS.pen, strokeWidth: bad } }),
      )
      expect(load().pen.strokeWidth).toBe(DEFAULTS.pen.strokeWidth)
    }
  })

  it('rejects NaN and Infinity outright — R-SEC-004 by the back door', () => {
    // JSON cannot carry these literally, but null round-trips from them and a
    // hand-edited value can be anything. An Infinity reaching the renderer as
    // a lineWidth blanks the layer.
    store(
      '{"activeTool":"pen","pen":{"color":"#EF4444","strokeWidth":null,"opacity":null}}',
    )
    const out = load()
    expect(out.pen.strokeWidth).toBe(DEFAULTS.pen.strokeWidth)
    expect(out.pen.opacity).toBe(DEFAULTS.pen.opacity)
  })

  it('keeps the valid fields when only one is corrupt', () => {
    store(
      JSON.stringify({
        activeTool: 'pen',
        pen: { color: '#EF4444', strokeWidth: 'wide' },
      }),
    )
    const out = load()
    expect(out.activeTool).toBe('pen')
    expect(out.pen.color).toBe('#EF4444')
    expect(out.pen.strokeWidth).toBe(DEFAULTS.pen.strokeWidth)
  })

  it('survives a missing pen object entirely', () => {
    store(JSON.stringify({ activeTool: 'hand' }))
    expect(load()).toEqual({ activeTool: 'hand', pen: DEFAULTS.pen })
  })
})

describe('hostile or absent storage', () => {
  it('does not throw when localStorage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(() => savePrefs(DEFAULTS)).not.toThrow()
    expect(load()).toEqual(DEFAULTS)
  })

  it('does not throw when setItem rejects — quota or private mode', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('QuotaExceededError')
      },
    } as unknown as Storage)

    // Preferences are a nicety. Failing to store one must never break drawing.
    expect(() => savePrefs(DEFAULTS)).not.toThrow()
  })

  it('does not throw when getItem rejects', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new DOMException('SecurityError')
      },
      setItem: () => {},
    } as unknown as Storage)

    expect(load()).toEqual(DEFAULTS)
  })
})
