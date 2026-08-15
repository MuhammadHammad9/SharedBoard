import type { Config } from 'tailwindcss'
import { PRESENCE_COLOURS, STICKY_COLOURS } from '@coboard/shared'

/**
 * PRD §15 design tokens — the single source of truth.
 *
 * R-UI-001 (Blocking): these values are the contract, not a starting point.
 * R-UI-002 (Blocking): never use an arbitrary colour value. If a colour is not
 *   here, it does not go in the product.
 * C-7: the `ui-ux-pro-max` generator suggests teal #0D9488 + Plus Jakarta Sans
 *   for this product. PRD §15 wins. Its colour and typography output is
 *   advisory only (R-SKILL-020).
 * C-1: Inter is mandated on all 22 screens. The font bans in
 *   high-end-visual-design, gpt-taste and design-taste-frontend are overridden.
 * C-8: Tailwind 3.x, not v4.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
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
        // Frozen palettes — R-UI-013, R-UI-014. Sourced from @coboard/shared so
        // the server and client cannot drift.
        presence: Object.fromEntries(PRESENCE_COLOURS.map((c, i) => [i + 1, c])),
        sticky: STICKY_COLOURS,
      },
      borderRadius: {
        sm: '4px',
        md: '8px',
        lg: '12px',
      },
      spacing: {
        1: '4px',
        2: '8px',
        3: '12px',
        4: '16px',
        6: '24px',
        8: '32px',
        12: '48px',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      boxShadow: {
        panel: '0 1px 3px rgba(0,0,0,.08), 0 4px 12px rgba(0,0,0,.06)',
      },
      transitionDuration: {
        fast: '120ms',
        base: '200ms',
        slow: '320ms',
      },
      transitionTimingFunction: {
        // PRD §15 default
        standard: 'cubic-bezier(0.2, 0, 0, 1)',
        // emil-design-eng curves — R-MOTION-012. Built-in CSS easings are too weak.
        out: 'cubic-bezier(0.23, 1, 0.32, 1)',
        'in-out': 'cubic-bezier(0.77, 0, 0.175, 1)',
        drawer: 'cubic-bezier(0.32, 0.72, 0, 1)',
      },
      zIndex: {
        // Systemic layers only — R-UI-045. Never z-[9999].
        canvas: '0',
        panel: '20',
        guestbar: '25',
        header: '30',
        // Above the header so a tooltip on a header control is not clipped by
        // it; below toasts, which must never be obscured.
        tooltip: '35',
        toast: '40',
        backdrop: '45',
        modal: '50',
        fullscreen: '60',
      },
    },
  },
  plugins: [],
} satisfies Config
