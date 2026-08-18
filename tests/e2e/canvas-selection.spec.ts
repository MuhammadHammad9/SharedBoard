import { expect, test, type Page } from '@playwright/test'
import { stubSession } from './support/session.js'

/**
 * Selection and transform e2e — FR-CANVAS-004/006/011/012/014/022,
 * FLOWS §8.2.3, §15.1, E-11.
 *
 * Every test draws its own strokes first, because Phase 4 has no way to create
 * an object except by drawing one. That makes each test a full round trip
 * through Phase 3's pen and Phase 4's selection, which is the honest thing to
 * exercise anyway.
 */

/*
 * The board route now needs a board id — Phase 7 introduced the router.
 * Boards are not persisted until Phase 8, so any id renders the same empty
 * canvas; the id is a route parameter, not a lookup.
 */
const BOARD = '/board/e2e?debug=1'

interface TestObject {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
  color?: string
  strokeWidth?: number
  opacity: number
}

async function surface(page: Page) {
  const el = page.getByTestId('canvas-surface')
  await expect(el).toHaveAttribute('data-ready', 'true')
  return el
}

const objects = (page: Page): Promise<TestObject[]> =>
  page.evaluate(
    () =>
      (
        window as unknown as { __coboardObjects: () => TestObject[] }
      ).__coboardObjects() as TestObject[],
  )

const selection = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    (window as unknown as { __coboardSelection: () => string[] }).__coboardSelection(),
  )

/** Draw a stroke from (x1,y1) to (x2,y2) in viewport coordinates. */
async function draw(page: Page, x1: number, y1: number, x2: number, y2: number) {
  await page.getByTestId('tool-pen').click()
  await page.mouse.move(x1, y1)
  await page.mouse.down()
  await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 4 })
  await page.mouse.move(x2, y2, { steps: 4 })
  await page.mouse.up()
  await page.getByTestId('tool-select').click()
}

test.beforeEach(async ({ page }) => {
  await stubSession(page)
  await page.goto(BOARD)
  await surface(page)
  await page.getByTestId('tool-select').click()
})

test('click selects, click-empty deselects — FR-CANVAS-004', async ({ page }) => {
  await draw(page, 300, 300, 400, 380)
  await expect.poll(async () => (await objects(page)).length).toBe(1)

  const [o] = await objects(page)
  await page.mouse.click(350, 340)
  await expect.poll(() => selection(page)).toEqual([o!.id])

  // The selection overlay is a canvas, so its presence is asserted through
  // the store rather than the DOM.
  await page.mouse.click(800, 600)
  await expect.poll(() => selection(page)).toEqual([])
})

test('shift+click toggles membership — FR-CANVAS-004', async ({ page }) => {
  await draw(page, 250, 250, 320, 320)
  await draw(page, 500, 250, 570, 320)
  await expect.poll(async () => (await objects(page)).length).toBe(2)

  await page.mouse.click(285, 285)
  await expect.poll(async () => (await selection(page)).length).toBe(1)

  await page.keyboard.down('Shift')
  await page.mouse.click(535, 285)
  await page.keyboard.up('Shift')
  await expect.poll(async () => (await selection(page)).length).toBe(2)

  // Shift+click again removes it.
  await page.keyboard.down('Shift')
  await page.mouse.click(535, 285)
  await page.keyboard.up('Shift')
  await expect.poll(async () => (await selection(page)).length).toBe(1)
})

test('marquee selects only fully-contained objects — FR-CANVAS-004', async ({ page }) => {
  await draw(page, 250, 250, 320, 320)
  await draw(page, 700, 250, 770, 320)
  await expect.poll(async () => (await objects(page)).length).toBe(2)

  // A marquee that encloses the first and only clips the second.
  await page.mouse.move(200, 200)
  await page.mouse.down()
  await page.mouse.move(400, 400, { steps: 8 })
  await page.mouse.up()

  await expect.poll(async () => (await selection(page)).length).toBe(1)
})

test('drag moves the selection — FR-CANVAS-011', async ({ page }) => {
  await draw(page, 300, 300, 380, 380)
  const [before] = await objects(page)

  await page.mouse.click(340, 340)
  await expect.poll(async () => (await selection(page)).length).toBe(1)

  await page.mouse.move(340, 340)
  await page.mouse.down()
  await page.mouse.move(440, 400, { steps: 10 })
  await page.mouse.up()

  const [after] = await objects(page)
  expect(after!.x - before!.x).toBeGreaterThan(80)
  expect(after!.y - before!.y).toBeGreaterThan(40)
})

test('arrow keys nudge 1 px, shift+arrow 10 px — FR-CANVAS-011', async ({ page }) => {
  await draw(page, 300, 300, 380, 380)
  await page.mouse.click(340, 340)
  await expect.poll(async () => (await selection(page)).length).toBe(1)

  const [start] = await objects(page)
  await (await surface(page)).focus()

  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await objects(page))[0]!.x).toBeCloseTo(start!.x + 1, 1)

  await page.keyboard.press('Shift+ArrowRight')
  await expect.poll(async () => (await objects(page))[0]!.x).toBeCloseTo(start!.x + 11, 1)

  await page.keyboard.press('ArrowDown')
  await expect.poll(async () => (await objects(page))[0]!.y).toBeCloseTo(start!.y + 1, 1)
})

test('resize from a corner handle — FR-CANVAS-012', async ({ page }) => {
  await draw(page, 300, 300, 400, 400)
  await page.mouse.click(350, 350)
  await expect.poll(async () => (await selection(page)).length).toBe(1)

  const [before] = await objects(page)
  // The 'se' handle sits at the box's bottom-right, in canvas coords. At
  // zoom 1 with no pan, canvas and viewport coordinates coincide.
  const seX = before!.x + before!.width
  const seY = before!.y + before!.height

  await page.mouse.move(seX, seY)
  await page.mouse.down()
  await page.mouse.move(seX + 120, seY + 120, { steps: 10 })
  await page.mouse.up()

  const [after] = await objects(page)
  expect(after!.width).toBeGreaterThan(before!.width + 80)
  expect(after!.height).toBeGreaterThan(before!.height + 80)
})

test('resize clamps at the 8×8 minimum — FR-CANVAS-012', async ({ page }) => {
  await draw(page, 300, 300, 400, 400)
  await page.mouse.click(350, 350)
  await expect.poll(async () => (await selection(page)).length).toBe(1)

  const [before] = await objects(page)
  const seX = before!.x + before!.width
  const seY = before!.y + before!.height

  // Drag the 'se' handle far past the 'nw' anchor.
  await page.mouse.move(seX, seY)
  await page.mouse.down()
  await page.mouse.move(before!.x - 400, before!.y - 400, { steps: 12 })
  await page.mouse.up()

  const [after] = await objects(page)
  expect(after!.width).toBeGreaterThanOrEqual(8)
  expect(after!.height).toBeGreaterThanOrEqual(8)
})

test('rotate with the handle, Shift snaps to 15° — FR-CANVAS-013', async ({ page }) => {
  await draw(page, 300, 300, 400, 400)
  await page.mouse.click(350, 350)
  await expect.poll(async () => (await selection(page)).length).toBe(1)

  const [before] = await objects(page)
  const cx = before!.x + before!.width / 2
  const rotateY = before!.y - 24

  await page.mouse.move(cx, rotateY)
  await page.mouse.down()
  await page.keyboard.down('Shift')
  await page.mouse.move(cx + 150, before!.y + before!.height / 2, { steps: 12 })
  await page.keyboard.up('Shift')
  await page.mouse.up()

  const [after] = await objects(page)
  expect(after!.rotation).toBeGreaterThan(0)
  expect(after!.rotation % 15).toBeCloseTo(0, 4)
})

test('Delete removes the selection — FR-CANVAS-014', async ({ page }) => {
  await draw(page, 300, 300, 380, 380)
  await page.mouse.click(340, 340)
  await expect.poll(async () => (await selection(page)).length).toBe(1)

  await (await surface(page)).focus()
  await page.keyboard.press('Delete')

  await expect.poll(async () => (await objects(page)).length).toBe(0)
})

test('Cmd+A selects all, Escape deselects — FR-CANVAS-022', async ({ page }) => {
  await draw(page, 250, 250, 320, 320)
  await draw(page, 500, 400, 570, 470)
  await expect.poll(async () => (await objects(page)).length).toBe(2)

  await (await surface(page)).focus()
  await page.keyboard.press('Control+a')
  await expect.poll(async () => (await selection(page)).length).toBe(2)

  await page.keyboard.press('Escape')
  await expect.poll(() => selection(page)).toEqual([])
  await expect(page.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true')
})

test('the properties panel shows the selection, and Mixed — FLOWS §14.4', async ({
  page,
}) => {
  await draw(page, 250, 250, 320, 320)
  await page.getByTestId('tool-pen').click()
  await page.getByRole('button', { name: 'Colour #EF4444' }).click()
  await draw(page, 500, 250, 570, 320)

  await (await surface(page)).focus()
  await page.keyboard.press('Control+a')

  await expect(page.getByTestId('properties-panel')).toHaveAttribute(
    'data-context',
    'selection',
  )
  await expect(page.getByTestId('selection-properties')).toContainText('2 objects')
  // The two strokes have different colours.
  await expect(page.getByTestId('mixed-value').first()).toBeVisible()
})

test('the eraser highlights on hover and deletes on drag — FR-CANVAS-006', async ({
  page,
}) => {
  await draw(page, 300, 300, 380, 380)
  await draw(page, 500, 300, 580, 380)
  await expect.poll(async () => (await objects(page)).length).toBe(2)

  await page.getByTestId('tool-eraser').click()
  await expect(page.getByTestId('properties-panel')).toHaveAttribute(
    'data-context',
    'eraser',
  )

  // Hover highlights without deleting.
  await page.mouse.move(340, 340)
  await page.waitForTimeout(120)
  expect((await objects(page)).length).toBe(2)

  // Drag across both.
  await page.mouse.down()
  await page.mouse.move(540, 340, { steps: 20 })
  await page.mouse.up()

  await expect.poll(async () => (await objects(page)).length).toBe(0)
})

test('Escape mid-drag reverts the move — R-CANVAS-052 sibling path', async ({ page }) => {
  await draw(page, 300, 300, 380, 380)
  await page.mouse.click(340, 340)
  await expect.poll(async () => (await selection(page)).length).toBe(1)

  const [before] = await objects(page)

  await page.mouse.move(340, 340)
  await page.mouse.down()
  await page.mouse.move(500, 500, { steps: 10 })
  await page.keyboard.press('Escape')
  await page.mouse.up()

  const [after] = await objects(page)
  expect(after!.x).toBeCloseTo(before!.x, 1)
  expect(after!.y).toBeCloseTo(before!.y, 1)
})

test('a 1 px line is selectable at 10% zoom — FLOWS E-11', async ({ page }) => {
  await page.getByTestId('tool-pen').click()
  await page.getByRole('button', { name: 'Thickness 1 pixels' }).click()
  await page.mouse.move(300, 400)
  await page.mouse.down()
  await page.mouse.move(700, 400, { steps: 10 })
  await page.mouse.up()
  await page.getByTestId('tool-select').click()
  await expect.poll(async () => (await objects(page)).length).toBe(1)

  // Zoom all the way out.
  const zoomOut = page.getByRole('button', { name: 'Zoom out' })
  for (let i = 0; i < 30; i++) {
    if (await zoomOut.isDisabled()) break
    await zoomOut.click()
  }
  await expect(zoomOut).toBeDisabled()

  /*
   * Convert the line's canvas midpoint to screen and click near — but not
   * exactly on — it. Without the 4/zoom tolerance this is unclickable.
   *
   * The viewport comes from `__coboardViewport`, NOT from the ?debug=1
   * overlay. The overlay repaints on a 250 ms interval by design, so reading
   * it straight after a zoom yields a stale pan and a target tens of pixels
   * off — which is exactly how this test passed locally and failed on CI.
   */
  const [line] = await objects(page)
  const target = await page.evaluate(
    ([cx, cy]) => {
      const v = (
        window as unknown as {
          __coboardViewport: () => { x: number; y: number; zoom: number }
        }
      ).__coboardViewport()
      return { x: cx! * v.zoom + v.x, y: cy! * v.zoom + v.y, zoom: v.zoom }
    },
    [line!.x + line!.width / 2, line!.y + line!.height / 2],
  )

  expect(target.zoom).toBeCloseTo(0.1, 5)

  // 2 screen px off the path. The tolerance is 4 screen px at any zoom, so
  // this must hit — and at 10% zoom it is 20 canvas units away from a line
  // one tenth of a screen pixel wide.
  const box = (await (await surface(page)).boundingBox())!
  await page.mouse.click(box.x + target.x, box.y + target.y + 2)

  await expect.poll(async () => (await selection(page)).length).toBe(1)
})

test('selection does NOT repaint the object layer — R-CANVAS-002', async ({ page }) => {
  await draw(page, 300, 300, 380, 380)
  await page.mouse.click(340, 340)
  await expect.poll(async () => (await selection(page)).length).toBe(1)

  await page.evaluate(() =>
    (window as unknown as { __coboardResetMetrics: () => void }).__coboardResetMetrics(),
  )

  // Hover across the selection box without pressing. The overlay may repaint;
  // layer 1 must not.
  for (let i = 0; i < 20; i++) await page.mouse.move(300 + i * 4, 340)

  const m = await page.evaluate(() =>
    (
      window as unknown as {
        __coboardMetrics: () => { objectPaints: number; overlayPaints: number }
      }
    ).__coboardMetrics(),
  )
  expect(m.objectPaints).toBe(0)
})
