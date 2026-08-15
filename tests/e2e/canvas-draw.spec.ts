import { expect, test, type Page } from '@playwright/test'

/**
 * Drawing e2e — FR-CANVAS-005, FLOWS §8.2.1, §14.4.
 *
 * State is read through the `?debug=1` overlay and the store, not by reaching
 * into renderer internals. The overlay repaints on a 250 ms interval by
 * design — re-rendering React every frame to display a frame counter would
 * corrupt the number it reports — so every read uses `expect.poll`.
 */

const BOARD = '/?debug=1'

async function surface(page: Page) {
  const el = page.getByTestId('canvas-surface')
  await expect(el).toHaveAttribute('data-ready', 'true')
  return el
}

/** Total object count, straight off the canvas's own accessible name. */
async function objectCount(page: Page): Promise<number> {
  const label = (await page.getByTestId('canvas-surface').getAttribute('aria-label')) ?? ''
  return Number.parseInt(label.replace(/\D+/g, ''), 10) || 0
}

/** The committed objects, read from the store the same way the renderer does. */
async function objects(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __coboardObjects?: () => unknown[] }
    return (w.__coboardObjects?.() ?? []) as {
      type: string
      points: number[]
      color: string
      strokeWidth: number
      opacity: number
      x: number
      y: number
      width: number
      height: number
    }[]
  })
}

/** Drag a curved path so simplification has redundancy to remove. */
async function scribble(page: Page, steps = 40) {
  const box = (await page.getByTestId('canvas-surface').boundingBox())!
  const cx = box.x + 400
  const cy = box.y + 300

  await page.mouse.move(cx, cy)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    await page.mouse.move(cx + t * 300, cy + Math.sin(t * 8) * 90, { steps: 3 })
  }
  await page.mouse.up()
}

test.beforeEach(async ({ page }) => {
  await page.goto(BOARD)
  await surface(page)
  // Start every test from the same tool, regardless of what localStorage
  // carried over from the previous one.
  await page.getByTestId('tool-pen').click()
})

test('the toolbar renders and the pen can be selected — FLOWS §14.2', async ({ page }) => {
  await expect(page.getByTestId('toolbar')).toBeVisible()
  await expect(page.getByTestId('tool-pen')).toHaveAttribute('aria-pressed', 'true')
  // The pen's crosshair is the affordance that says "this will draw".
  await expect(page.getByTestId('canvas-surface')).toHaveCSS('cursor', 'crosshair')
})

test('the properties panel swaps to pen context — FLOWS §14.4', async ({ page }) => {
  await expect(page.getByTestId('properties-panel')).toHaveAttribute('data-context', 'pen')
  await expect(page.getByTestId('pen-properties')).toBeVisible()

  // Select with an empty selection hides the panel entirely.
  await page.getByTestId('tool-select').click()
  await expect(page.getByTestId('properties-panel')).toHaveCount(0)
})

test('a drag commits one stroke — FR-CANVAS-005', async ({ page }) => {
  expect(await objectCount(page)).toBe(0)
  await scribble(page)

  await expect.poll(() => objectCount(page)).toBe(1)

  const [stroke] = await objects(page)
  expect(stroke!.type).toBe('stroke')
  expect(stroke!.width).toBeGreaterThan(200)
})

test('the committed stroke is simplified — R-CANVAS-032', async ({ page }) => {
  // 60 mouse.move calls at 3 interpolation steps each is ~180 raw samples,
  // plus whatever coalescing adds.
  await scribble(page, 60)
  await expect.poll(() => objectCount(page)).toBe(1)

  const [stroke] = await objects(page)
  const committed = stroke!.points.length / 3

  // The exact count depends on the path and the pointer rate; the property
  // that matters is that RDP demonstrably ran and cut the sample count down.
  expect(committed).toBeGreaterThanOrEqual(2)
  expect(committed).toBeLessThan(120)
  console.log(`[draw] committed points: ${committed}`)
})

test('a click without a drag creates nothing', async ({ page }) => {
  const box = (await page.getByTestId('canvas-surface').boundingBox())!
  await page.mouse.click(box.x + 200, box.y + 200)

  // Give the commit path a chance to have got it wrong.
  await page.waitForTimeout(300)
  expect(await objectCount(page)).toBe(0)
})

test('Escape mid-stroke discards it entirely — FLOWS E-09', async ({ page }) => {
  const box = (await page.getByTestId('canvas-surface').boundingBox())!
  await page.mouse.move(box.x + 300, box.y + 300)
  await page.mouse.down()
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + 300 + i * 20, box.y + 300 + i * 5)

  await page.keyboard.press('Escape')
  await page.mouse.up()

  await page.waitForTimeout(300)
  expect(await objectCount(page)).toBe(0)
})

test('Space held mid-stroke does not pan — R-CANVAS-051', async ({ page }) => {
  const box = (await page.getByTestId('canvas-surface').boundingBox())!
  const panBefore = await page.getByTestId('dbg-pan').textContent()

  await page.mouse.move(box.x + 300, box.y + 300)
  await page.mouse.down()
  await page.mouse.move(box.x + 340, box.y + 320, { steps: 4 })
  await page.keyboard.down('Space')
  await page.mouse.move(box.x + 420, box.y + 380, { steps: 6 })
  await page.keyboard.up('Space')
  await page.mouse.up()

  // The viewport must not have moved — the whole gesture was one stroke.
  await expect.poll(() => page.getByTestId('dbg-pan').textContent()).toBe(panBefore)
  await expect.poll(() => objectCount(page)).toBe(1)
})

test('colour and thickness from the panel land on the object', async ({ page }) => {
  await page.getByRole('button', { name: 'Colour #EF4444' }).click()
  await page.getByRole('button', { name: 'Thickness 12 pixels' }).click()

  await scribble(page, 20)
  await expect.poll(() => objectCount(page)).toBe(1)

  const [stroke] = await objects(page)
  expect(stroke!.color.toUpperCase()).toBe('#EF4444')
  expect(stroke!.strokeWidth).toBe(12)
})

test('drawing does NOT repaint the object layer — R-CANVAS-002', async ({ page }) => {
  /*
   * The phase's most important assertion, and the reason the layer stack
   * exists. An in-progress stroke lives on layer 2; if it dirties layer 1 as
   * well, every pointermove repaints all 10,000 committed objects. The same
   * mechanism carries remote cursors in Phase 10, where the cost lands on
   * someone else's machine.
   */
  const box = (await page.getByTestId('canvas-surface').boundingBox())!

  await page.evaluate(() => {
    ;(window as unknown as { __coboardResetMetrics: () => void }).__coboardResetMetrics()
  })

  await page.mouse.move(box.x + 300, box.y + 300)
  await page.mouse.down()
  const objectPaintsAtStart = await page.evaluate(
    () =>
      (window as unknown as { __coboardMetrics: () => { objectPaints: number } }).__coboardMetrics()
        .objectPaints,
  )

  for (let i = 1; i <= 30; i++) {
    await page.mouse.move(box.x + 300 + i * 8, box.y + 300 + Math.sin(i / 3) * 40)
  }

  const mid = await page.evaluate(
    () =>
      (
        window as unknown as {
          __coboardMetrics: () => { objectPaints: number; interactionPaints: number }
        }
      ).__coboardMetrics(),
  )
  await page.mouse.up()

  // Layer 2 repainted many times over the drag...
  expect(mid.interactionPaints).toBeGreaterThan(5)
  // ...and layer 1 did not repaint at all.
  expect(mid.objectPaints).toBe(objectPaintsAtStart)
})

test('the tool choice survives a reload — R-STATE-005', async ({ page }) => {
  await page.getByRole('button', { name: 'Thickness 6 pixels' }).click()

  await page.reload()
  await surface(page)

  await expect(page.getByTestId('tool-pen')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('pen-width-slider')).toHaveValue('6')
})

test('the P shortcut selects the pen — PRD Appendix A', async ({ page }) => {
  await page.getByTestId('tool-select').click()
  await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true')

  await (await surface(page)).focus()
  await page.keyboard.press('p')

  await expect(page.getByTestId('tool-pen')).toHaveAttribute('aria-pressed', 'true')
})
