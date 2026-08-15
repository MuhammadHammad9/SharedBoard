import { expect, test, type Page } from '@playwright/test'

/**
 * Canvas viewport e2e — FR-CANVAS-001/002/003.
 *
 * Viewport state is read through the ?debug=1 overlay rather than by reaching
 * into internals, so these tests exercise the same numbers a developer sees.
 *
 * The overlay repaints on a 250 ms interval — deliberately, because
 * re-rendering React every frame to display a frame counter would corrupt the
 * very number it reports. Every read below therefore uses expect.poll so the
 * assertion retries until the overlay catches up. Reading synchronously after
 * an action tests the poll interval, not the viewport.
 */

const BOARD = '/?debug=1'

async function readZoom(page: Page): Promise<number> {
  const text = await page.getByTestId('dbg-zoom').textContent()
  return Number.parseFloat((text ?? '0').replace('%', ''))
}

async function readPan(page: Page): Promise<{ x: number; y: number }> {
  const text = (await page.getByTestId('dbg-pan').textContent()) ?? '0, 0'
  const [x, y] = text.split(',').map(s => Number.parseFloat(s.trim()))
  return { x: x ?? 0, y: y ?? 0 }
}

async function surface(page: Page) {
  const el = page.getByTestId('canvas-surface')
  await expect(el).toHaveAttribute('data-ready', 'true')
  await expect(page.getByTestId('debug-overlay')).toBeVisible()
  return el
}

test.beforeEach(async ({ page }) => {
  await page.goto(BOARD)
  await surface(page)
})

test('mounts the layer stack in the documented z-order', async ({ page }) => {
  // FLOWS §14.3. Layer 0 (grid) is [P2] and deliberately absent.
  await expect(page.locator('canvas#objects')).toBeAttached()
  await expect(page.locator('canvas#interaction')).toBeAttached()
  await expect(page.locator('canvas#overlay')).toBeAttached()
  await expect(page.locator('#text-overlay')).toBeAttached()
})

test('runs exactly one requestAnimationFrame loop — R-CANVAS-010', async ({ page }) => {
  const perFrame = await page.evaluate(async () => {
    const original = window.requestAnimationFrame.bind(window)
    let calls = 0
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      calls++
      return original(cb)
    }
    const frames = 20
    await new Promise<void>(resolve => {
      let n = 0
      const tick = () => (++n >= frames ? resolve() : original(tick))
      original(tick)
    })
    window.requestAnimationFrame = original
    return (calls - frames) / frames
  })

  // One loop re-arms about once per frame. Anything near 2 means a second loop.
  expect(perFrame).toBeLessThan(1.6)
})

test('pans with a middle-mouse drag — FR-CANVAS-002', async ({ page }) => {
  const el = await surface(page)
  const box = (await el.boundingBox())!

  await page.mouse.move(box.x + 400, box.y + 300)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(box.x + 500, box.y + 360, { steps: 8 })
  await page.mouse.up({ button: 'middle' })

  await expect.poll(async () => (await readPan(page)).x).toBeGreaterThan(50)
  await expect.poll(async () => (await readPan(page)).y).toBeGreaterThan(30)
})

test('pans with space + drag — FR-CANVAS-002', async ({ page }) => {
  const el = await surface(page)
  const box = (await el.boundingBox())!

  await el.focus()
  await page.keyboard.down('Space')
  await page.mouse.move(box.x + 300, box.y + 300)
  await page.mouse.down()
  await page.mouse.move(box.x + 380, box.y + 300, { steps: 6 })
  await page.mouse.up()
  await page.keyboard.up('Space')

  await expect.poll(async () => (await readPan(page)).x).toBeGreaterThan(40)
})

test('pans with the hand tool — FR-CANVAS-002', async ({ page }) => {
  const el = await surface(page)
  const box = (await el.boundingBox())!
  await el.focus()
  await page.keyboard.press('h')

  await page.mouse.move(box.x + 300, box.y + 300)
  await page.mouse.down()
  await page.mouse.move(box.x + 300, box.y + 380, { steps: 6 })
  await page.mouse.up()

  await expect.poll(async () => (await readPan(page)).y).toBeGreaterThan(40)
})

test('pans with two-finger trackpad scroll — FR-CANVAS-002', async ({ page }) => {
  const el = await surface(page)
  const box = (await el.boundingBox())!

  await page.mouse.move(box.x + 400, box.y + 300)
  await page.mouse.wheel(60, 40) // ctrlKey false → pan, not zoom

  // Scrolling right/down moves the content the other way.
  await expect.poll(async () => (await readPan(page)).x).toBeLessThan(0)
  // Zoom must be untouched by a plain scroll.
  await expect.poll(() => readZoom(page)).toBeCloseTo(100, 1)
})

test('zoom buttons change zoom and the readout', async ({ page }) => {
  await expect(page.getByTestId('zoom-controls')).toBeVisible()

  await page.getByRole('button', { name: 'Zoom in' }).click()
  await expect.poll(() => readZoom(page)).toBeGreaterThan(100)

  await page.getByRole('button', { name: /Zoom \d+ percent/ }).click()
  await expect.poll(() => readZoom(page)).toBeCloseTo(100, 1)

  await page.getByRole('button', { name: 'Zoom out' }).click()
  await expect.poll(() => readZoom(page)).toBeLessThan(100)
})

test('zoom is anchored at the pointer — R-COORD-005', async ({ page }) => {
  const el = await surface(page)
  const box = (await el.boundingBox())!
  const px = 250
  const py = 180

  /** World coordinate currently under a given screen point, per the overlay. */
  const worldUnder = (x: number, y: number) =>
    page.evaluate(
      ([sx, sy]) => {
        const pan = document.querySelector('[data-testid="dbg-pan"]')!.textContent!.split(',')
        const zoom =
          Number.parseFloat(
            document.querySelector('[data-testid="dbg-zoom"]')!.textContent!.replace('%', ''),
          ) / 100
        return {
          x: (sx! - Number.parseFloat(pan[0]!)) / zoom,
          y: (sy! - Number.parseFloat(pan[1]!)) / zoom,
        }
      },
      [x, y],
    )

  const before = await worldUnder(px, py)

  await page.mouse.move(box.x + px, box.y + py)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -240)
  await page.keyboard.up('Control')

  await expect.poll(() => readZoom(page)).toBeGreaterThan(100)

  const after = await worldUnder(px, py)
  // The world point under the cursor must not move. Tolerance covers the
  // one-decimal rounding in the overlay readout.
  expect(Math.abs(after.x - before.x)).toBeLessThan(2)
  expect(Math.abs(after.y - before.y)).toBeLessThan(2)
})

test('zoom clamps at 10% and 500% — FR-CANVAS-003', async ({ page }) => {
  const zoomOut = page.getByRole('button', { name: 'Zoom out' })
  for (let i = 0; i < 30; i++) {
    if (await zoomOut.isDisabled()) break
    await zoomOut.click()
  }
  await expect(zoomOut).toBeDisabled()
  await expect.poll(() => readZoom(page)).toBeCloseTo(10, 1)

  const zoomIn = page.getByRole('button', { name: 'Zoom in' })
  for (let i = 0; i < 40; i++) {
    if (await zoomIn.isDisabled()) break
    await zoomIn.click()
  }
  await expect(zoomIn).toBeDisabled()
  await expect.poll(() => readZoom(page)).toBeCloseTo(500, 1)
})

test('keyboard zoom shortcuts work — PRD Appendix A', async ({ page }) => {
  const el = await surface(page)
  await el.focus()

  await page.keyboard.press('Control+Equal')
  await expect.poll(() => readZoom(page)).toBeGreaterThan(100)

  await page.keyboard.press('Control+0')
  await expect.poll(() => readZoom(page)).toBeCloseTo(100, 1)

  await page.keyboard.press('Control+Minus')
  await expect.poll(() => readZoom(page)).toBeLessThan(100)
})

test('zoom to fit resets an empty board to origin at 100%', async ({ page }) => {
  const el = await surface(page)
  const box = (await el.boundingBox())!
  await page.mouse.move(box.x + 300, box.y + 300)
  await page.mouse.wheel(120, 120)

  await page.getByTestId('zoom-to-fit').click()

  await expect.poll(() => readZoom(page)).toBeCloseTo(100, 1)
  await expect.poll(async () => Math.abs((await readPan(page)).x)).toBeLessThan(0.5)
  await expect.poll(async () => Math.abs((await readPan(page)).y)).toBeLessThan(0.5)
})

test('the canvas is focusable and has a text alternative — R-A11Y-006/008', async ({ page }) => {
  const el = await surface(page)
  await expect(el).toHaveAttribute('tabindex', '0')
  await expect(el).toHaveAttribute('role', 'img')
  await expect(el).toHaveAttribute('aria-label', /Whiteboard with \d+ objects/)
})
