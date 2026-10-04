import { expect, test } from '@playwright/test'
import { stubSession } from './support/session.js'

/**
 * Cross-browser stroke rendering — TRD §13.3: "Safari, Firefox, Chrome
 * stroke rendering … strokes must look identical". Phase 15g.
 *
 * The same fixed document — four freehand strokes of different widths and
 * curvature, a rectangle, an ellipse and an arrow — injected through the
 * local write path (not the mouse: pointer coalescing differs per engine and
 * would make the INPUT differ, not the rendering). Every browser's pixels
 * are compared against ONE golden (playwright.config.ts snapshotPathTemplate),
 * with a small tolerance for antialiasing, which legitimately differs.
 *
 * Firefox and WebKit run only with E2E_CROSS_BROWSER=1 (the CI
 * `cross-browser` job); the chromium run keeps the golden honest.
 */

test('strokes and shapes render the same in every engine', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await stubSession(page)
  await page.goto('/board/e2e')
  await expect(page.getByTestId('canvas-surface')).toHaveAttribute('data-ready', 'true')

  await page.evaluate(() => {
    const w = window as unknown as {
      __coboardApplyLocal: (ops: unknown[], label: string) => void
    }
    const base = {
      rotation: 0,
      opacity: 1,
      createdBy: 'xbrowser',
      createdAt: 1_760_000_000_000,
      updatedAt: 1_760_000_000_000,
    }
    const wave = (x0: number, y0: number, amp: number, n: number) => {
      const pts: number[] = []
      for (let i = 0; i < n; i++) pts.push(x0 + i * 12, y0 + Math.sin(i / 2.2) * amp, 0.5)
      return pts
    }
    const objects = [
      {
        type: 'stroke',
        points: wave(360, 260, 30, 24),
        color: '#18181B',
        strokeWidth: 2,
      },
      {
        type: 'stroke',
        points: wave(360, 340, 18, 24),
        color: '#3B82F6',
        strokeWidth: 6,
      },
      {
        type: 'stroke',
        points: wave(360, 420, 40, 24),
        color: '#EC4899',
        strokeWidth: 12,
      },
      { type: 'stroke', points: wave(360, 500, 8, 24), color: '#22C55E', strokeWidth: 4 },
    ].map((o, i) => ({
      ...base,
      ...o,
      simplified: true,
      x: 340,
      y: 220 + i * 80,
      width: 300,
      height: 80,
      zIndex: `a${i}`,
    }))
    const shapes = [
      { type: 'rect', x: 720, y: 240, width: 160, height: 100, cornerRadius: 8 },
      { type: 'ellipse', x: 720, y: 380, width: 160, height: 100 },
      { type: 'arrow', x: 720, y: 520, width: 160, height: 40, arrowEnd: true },
    ].map((o, i) => ({
      ...base,
      ...o,
      stroke: '#18181B',
      strokeWidth: 3,
      fill: o.type === 'arrow' ? 'none' : '#FEF08A',
      zIndex: `b${i}`,
    }))
    const ops = [...objects, ...shapes].map(payload => {
      const id = crypto.randomUUID()
      return {
        id: crypto.randomUUID(),
        type: 'CREATE',
        objectId: id,
        payload: { ...payload, id },
      }
    })
    w.__coboardApplyLocal(ops, 'Create')
  })
  // Selection handles would differ by nothing but timing; deselect.
  await page.keyboard.press('Escape')

  await expect(page).toHaveScreenshot('strokes.png', {
    // The drawing area only: clear of the toolbar, header and zoom controls.
    clip: { x: 320, y: 200, width: 600, height: 400 },
    maxDiffPixelRatio: 0.02,
    threshold: 0.3,
  })
})
