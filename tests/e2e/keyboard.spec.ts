import { expect, test, type Page } from '@playwright/test'
import { stubSession } from './support/session.js'

/**
 * Keyboard-only and reduced-motion passes — PRD §7.6, R-A11Y-*, R-MOTION-060.
 *
 * No mouse anywhere in the keyboard tests: every step is Tab, Enter, Escape or
 * a shortcut, and every assertion is on focus or on the state a pointer user
 * would see.
 */

/** Tab until `testId` has focus, failing after `limit` presses. */
async function tabTo(page: Page, testId: string, limit = 40) {
  for (let i = 0; i < limit; i++) {
    const focused = await page.evaluate(() =>
      document.activeElement?.getAttribute('data-testid'),
    )
    if (focused === testId) return
    await page.keyboard.press('Tab')
  }
  throw new Error(`Tab never reached ${testId}`)
}

test('the board is usable from the keyboard alone', async ({ page }) => {
  await stubSession(page)
  await page.goto('/board/e2e')
  await expect(page.getByTestId('canvas-surface')).toHaveAttribute('data-ready', 'true')

  // FLOWS §13.3: header first, then the toolbar.
  await tabTo(page, 'tool-pen')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('tool-pen')).toHaveAttribute('aria-pressed', 'true')

  // Visible focus — R-A11Y-003.
  const outline = await page
    .getByTestId('tool-pen')
    .evaluate(el => getComputedStyle(el).outlineStyle)
  expect(outline).not.toBe('none')

  // A tool shortcut works with focus in the toolbar.
  await page.keyboard.press('r')
  await expect(page.getByTestId('tool-rect')).toHaveAttribute('aria-pressed', 'true')

  // S-15: `?` opens the shortcuts, Escape closes them and focus comes home.
  await page.keyboard.press('Shift+Slash')
  await expect(page.getByTestId('shortcuts-modal')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('shortcuts-modal')).toHaveCount(0)
  // A shortcut changes the tool, not the focus: it returns to the pen button.
  await expect(page.getByTestId('tool-pen')).toBeFocused()
})

test('the shortcuts button is reachable by Tab, and its dialog traps focus', async ({
  page,
}) => {
  await stubSession(page)
  await page.goto('/board/e2e')
  await expect(page.getByTestId('canvas-surface')).toHaveAttribute('data-ready', 'true')
  await tabTo(page, 'shortcuts-button')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('shortcuts-modal')).toBeVisible()
  // Focus is trapped in the dialog: Tab never escapes to the board.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab')
    const inside = await page.evaluate(
      () => !!document.activeElement?.closest('[role="dialog"]'),
    )
    expect(inside).toBe(true)
  }
})

test.describe('with reduced motion', () => {
  /*
   * `page.emulateMedia`, not `test.use({ reducedMotion })`: with the
   * preinstalled Chromium the fixture option silently does not apply
   * (matchMedia still reports false), and a reduced-motion test that runs
   * without reduced motion passes for the wrong reason.
   */
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
  })

  test('modals keep the fade and drop the movement', async ({ page }) => {
    await stubSession(page)
    await page.goto('/board/e2e')
    await expect(page.getByTestId('canvas-surface')).toHaveAttribute('data-ready', 'true')
    await page.keyboard.press('Shift+Slash')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    const style = await dialog.evaluate(el => {
      const s = getComputedStyle(el)
      return {
        property: s.transitionProperty,
        animation: Number.parseFloat(s.animationDuration),
      }
    })
    // R-MOTION-060: fewer and gentler, not zero — opacity stays, transform goes.
    expect(style.property).not.toContain('transform')
    expect(style.animation).toBeLessThan(0.01)
  })
})
