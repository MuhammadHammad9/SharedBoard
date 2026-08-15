import { describe, expect, it } from 'vitest'
import config from '../../tailwind.config.js'

/**
 * Token fidelity.
 *
 * R-UI-001 (Blocking): PRD §15 is the single source of truth for design tokens.
 * This test compares the Tailwind theme against the token table verbatim, so
 * drift is caught mechanically rather than in review.
 *
 * Conflict C-7 is the reason this exists: running the `ui-ux-pro-max` design
 * system generator against this product returns teal #0D9488 and Plus Jakarta
 * Sans. Its colour and typography output is advisory only. If someone pastes
 * that palette in, this test fails.
 */

const theme = config.theme?.extend ?? {}
const colors = theme.colors as Record<string, unknown>

describe('PRD §15 colour tokens', () => {
  const expected: Record<string, string> = {
    canvas: '#FAFAFA',
    app: '#FFFFFF',
    subtle: '#F4F4F5',
    border: '#E4E4E7',
    primary: '#18181B',
    muted: '#71717A',
    accent: '#4F46E5',
    danger: '#DC2626',
    success: '#16A34A',
    warning: '#D97706',
  }

  for (const [token, value] of Object.entries(expected)) {
    it(`${token} is ${value}`, () => {
      expect(colors[token]).toBe(value)
    })
  }

  it('does not contain the ui-ux-pro-max generated palette (C-7)', () => {
    const flat = JSON.stringify(colors)
    // Teal primary / secondary and the orange CTA the generator suggests.
    expect(flat).not.toContain('#0D9488')
    expect(flat).not.toContain('#F0FDFA')
    expect(flat).not.toContain('#134E4A')
  })
})

describe('PRD §15 scale tokens', () => {
  it('maps radii to 4 / 8 / 12 px', () => {
    expect(theme.borderRadius).toMatchObject({ sm: '4px', md: '8px', lg: '12px' })
  })

  it('uses the 4px base spacing scale — R-UI-003', () => {
    expect(theme.spacing).toMatchObject({
      1: '4px',
      2: '8px',
      3: '12px',
      4: '16px',
      6: '24px',
      8: '32px',
      12: '48px',
    })
  })

  it('defines the panel shadow exactly', () => {
    expect((theme.boxShadow as Record<string, string>).panel).toBe(
      '0 1px 3px rgba(0,0,0,.08), 0 4px 12px rgba(0,0,0,.06)',
    )
  })

  it('maps durations to 120 / 200 / 320 ms', () => {
    expect(theme.transitionDuration).toMatchObject({
      fast: '120ms',
      base: '200ms',
      slow: '320ms',
    })
  })
})

describe('typography — conflict C-1', () => {
  it('uses Inter, overriding three skill font bans', () => {
    const sans = (theme.fontFamily as Record<string, string[]>).sans!
    expect(sans[0]).toBe('Inter')
    expect(sans).toEqual(['Inter', 'system-ui', '-apple-system', 'sans-serif'])
  })

  it('does not use a font the design skills would have picked', () => {
    const flat = JSON.stringify(theme.fontFamily)
    for (const banned of ['Plus Jakarta Sans', 'Satoshi', 'Cabinet Grotesk', 'Geist']) {
      expect(flat).not.toContain(banned)
    }
  })
})

describe('easing curves', () => {
  it('includes the PRD §15 standard curve and the three emil-design-eng curves', () => {
    expect(theme.transitionTimingFunction).toMatchObject({
      standard: 'cubic-bezier(0.2, 0, 0, 1)',
      out: 'cubic-bezier(0.23, 1, 0.32, 1)',
      'in-out': 'cubic-bezier(0.77, 0, 0.175, 1)',
      drawer: 'cubic-bezier(0.32, 0.72, 0, 1)',
    })
  })

  it('defines no ease-in curve — R-MOTION-010 bans it for UI', () => {
    expect(Object.keys(theme.transitionTimingFunction as object)).not.toContain('in')
  })
})

describe('frozen palettes are wired into the theme', () => {
  it('exposes 12 presence colours', () => {
    expect(Object.keys(colors.presence as object)).toHaveLength(12)
  })

  it('exposes 8 sticky colours', () => {
    expect(Object.keys(colors.sticky as object)).toHaveLength(8)
  })
})

describe('z-index scale — R-UI-045', () => {
  it('is systemic, with no arbitrary values', () => {
    expect(theme.zIndex).toMatchObject({
      canvas: '0',
      panel: '20',
      guestbar: '25',
      header: '30',
      toast: '40',
      backdrop: '45',
      modal: '50',
      fullscreen: '60',
    })
  })
})
