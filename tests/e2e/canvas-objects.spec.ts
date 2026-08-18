import { expect, test, type Page } from '@playwright/test'
import { stubSession } from './support/session.js'

/**
 * Shapes, sticky notes and text e2e — FR-CANVAS-007/008/009/015/019/020.
 *
 * The exit gate in prose: "All seven non-image object types render, create,
 * edit and transform correctly. A sticky note is click-and-type with no second
 * action. Empty text and empty notes never persist. Copy/paste works across
 * two browser tabs."
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
  text?: string
  color?: string
  stroke?: string
  fill?: string
  zIndex: string
}

async function surface(page: Page) {
  const el = page.getByTestId('canvas-surface')
  await expect(el).toHaveAttribute('data-ready', 'true')
  return el
}

const objects = (page: Page): Promise<TestObject[]> =>
  page.evaluate(() =>
    (window as unknown as { __coboardObjects: () => TestObject[] }).__coboardObjects(),
  )

const selection = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    (window as unknown as { __coboardSelection: () => string[] }).__coboardSelection(),
  )

/** Drag out a shape with the given tool. */
async function drawShape(
  page: Page,
  tool: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) {
  await page.getByTestId(`tool-${tool}`).click()
  await page.mouse.move(x1, y1)
  await page.mouse.down()
  await page.mouse.move(x2, y2, { steps: 6 })
  await page.mouse.up()
}

test.beforeEach(async ({ page }) => {
  await stubSession(page)
  await page.goto(BOARD)
  await surface(page)
  await page.getByTestId('tool-select').click()
})

test('every shape tool creates its own type — FR-CANVAS-007', async ({ page }) => {
  await drawShape(page, 'rect', 200, 200, 320, 280)
  await drawShape(page, 'ellipse', 380, 200, 500, 280)
  await drawShape(page, 'line', 560, 200, 680, 280)
  await drawShape(page, 'arrow', 740, 200, 860, 280)

  await expect.poll(async () => (await objects(page)).length).toBe(4)
  expect((await objects(page)).map(o => o.type)).toEqual([
    'rect',
    'ellipse',
    'line',
    'arrow',
  ])
})

test('Shift constrains a rect to a square — FR-CANVAS-007', async ({ page }) => {
  await page.getByTestId('tool-rect').click()
  await page.mouse.move(200, 200)
  await page.mouse.down()
  await page.keyboard.down('Shift')
  await page.mouse.move(400, 260, { steps: 8 })
  await page.keyboard.up('Shift')
  await page.mouse.up()

  await expect.poll(async () => (await objects(page)).length).toBe(1)
  const [o] = await objects(page)
  expect(o!.width).toBeCloseTo(o!.height, 1)
})

test('a click that never drags creates no shape', async ({ page }) => {
  await page.getByTestId('tool-rect').click()
  await page.mouse.click(300, 300)
  await page.waitForTimeout(250)
  expect(await objects(page)).toHaveLength(0)
})

test('a sticky note is click-and-type, no second action — FR-CANVAS-008', async ({
  page,
}) => {
  await page.getByTestId('tool-sticky').click()
  await page.mouse.click(400, 400)

  // The editor must be focused already: the first keystroke belongs in the
  // note, not on the document.
  await expect(page.getByTestId('text-overlay-input')).toBeFocused()
  await page.keyboard.type('Ship it')
  await page.keyboard.press('Escape')

  await expect.poll(async () => (await objects(page)).length).toBe(1)
  const [note] = await objects(page)
  expect(note!.type).toBe('sticky')
  expect(note!.text).toBe('Ship it')
  // FR-CANVAS-008: 200x200, centred on the click.
  expect(note!.width).toBe(200)
  expect(note!.height).toBe(200)
})

test('an empty sticky note is discarded on blur — FLOWS §8.2.2 step 4', async ({
  page,
}) => {
  await page.getByTestId('tool-sticky').click()
  await page.mouse.click(400, 400)
  await expect(page.getByTestId('text-overlay-input')).toBeFocused()

  // Leave without typing.
  await page.keyboard.press('Escape')

  await page.waitForTimeout(250)
  expect(await objects(page)).toHaveLength(0)
})

test('an empty text object is never persisted — FR-CANVAS-009', async ({ page }) => {
  await page.getByTestId('tool-text').click()
  await page.mouse.click(400, 300)
  await expect(page.getByTestId('text-overlay-input')).toBeFocused()
  await page.keyboard.press('Escape')

  await page.waitForTimeout(250)
  expect(await objects(page)).toHaveLength(0)
})

test('clearing an EXISTING note does not destroy it', async ({ page }) => {
  // The empty-discard rule applies only to objects created in that same
  // interaction. Clearing an existing note is a deliberate edit, and losing
  // its position, colour and z-order with the text would be data loss.
  await page.getByTestId('tool-sticky').click()
  await page.mouse.click(400, 400)
  await page.keyboard.type('temporary')
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await objects(page)).length).toBe(1)

  await page.getByTestId('tool-select').click()
  await page.mouse.dblclick(400, 400)
  await expect(page.getByTestId('text-overlay-input')).toBeFocused()
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  await page.keyboard.press('Escape')

  await page.waitForTimeout(250)
  const remaining = await objects(page)
  expect(remaining).toHaveLength(1)
  expect(remaining[0]!.text).toBe('')
})

test('double-click reopens an existing note for editing', async ({ page }) => {
  await page.getByTestId('tool-sticky').click()
  await page.mouse.click(400, 400)
  await page.keyboard.type('first')
  await page.keyboard.press('Escape')

  await page.getByTestId('tool-select').click()
  await page.mouse.dblclick(400, 400)
  await expect(page.getByTestId('text-overlay-input')).toBeFocused()
  await page.keyboard.type(' second')
  await page.keyboard.press('Escape')

  await expect.poll(async () => (await objects(page))[0]!.text).toBe('first second')
})

test('text renders live beneath the overlay while typing', async ({ page }) => {
  await page.getByTestId('tool-sticky').click()
  await page.mouse.click(400, 400)
  await page.keyboard.type('live')

  // The store holds the text before the edit is committed — that is what the
  // canvas is drawing underneath the transparent textarea.
  await expect.poll(async () => (await objects(page))[0]?.text).toBe('live')
})

test('duplicate offsets by 16,16 and assigns a NEW id — FR-CANVAS-015', async ({
  page,
}) => {
  await drawShape(page, 'rect', 300, 300, 400, 380)
  await expect.poll(async () => (await objects(page)).length).toBe(1)
  const [original] = await objects(page)

  await (await surface(page)).focus()
  await page.keyboard.press('Control+d')

  await expect.poll(async () => (await objects(page)).length).toBe(2)
  const all = await objects(page)
  const copy = all.find(o => o.id !== original!.id)!

  expect(copy.id).not.toBe(original!.id)
  expect(copy.x - original!.x).toBeCloseTo(16, 1)
  expect(copy.y - original!.y).toBeCloseTo(16, 1)
  // The copy is selected, so the user can immediately move it.
  await expect.poll(() => selection(page)).toEqual([copy.id])
})

test('copy and paste round-trips through the clipboard — FR-CANVAS-015', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])

  await drawShape(page, 'rect', 300, 300, 400, 380)
  await expect.poll(async () => (await objects(page)).length).toBe(1)

  await (await surface(page)).focus()
  await page.keyboard.press('Control+c')

  // Move the pointer: paste lands at the pointer, not the original position.
  await page.mouse.move(700, 500)
  await page.keyboard.press('Control+v')

  await expect.poll(async () => (await objects(page)).length).toBe(2)
  const all = await objects(page)
  expect(new Set(all.map(o => o.id)).size).toBe(2)
})

test('cut removes the original — FR-CANVAS-015', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])

  await drawShape(page, 'rect', 300, 300, 400, 380)
  await expect.poll(async () => (await objects(page)).length).toBe(1)

  await (await surface(page)).focus()
  await page.keyboard.press('Control+x')

  await expect.poll(async () => (await objects(page)).length).toBe(0)
})

test('the context menu offers the object actions — FR-CANVAS-019', async ({ page }) => {
  await drawShape(page, 'rect', 300, 300, 420, 380)
  await expect.poll(async () => (await objects(page)).length).toBe(1)

  await page.getByTestId('tool-select').click()
  await page.mouse.click(360, 340, { button: 'right' })

  const menu = page.getByTestId('context-menu')
  await expect(menu).toBeVisible()
  await expect(page.getByTestId('menu-duplicate')).toBeVisible()
  await expect(page.getByTestId('menu-bring-to-front')).toBeVisible()
  await expect(page.getByTestId('menu-send-to-back')).toBeVisible()

  await page.getByTestId('menu-duplicate').click()
  await expect(menu).toHaveCount(0)
  await expect.poll(async () => (await objects(page)).length).toBe(2)
})

test('the empty-canvas context menu offers Paste, Select all, Zoom to fit', async ({
  page,
}) => {
  await page.mouse.click(700, 500, { button: 'right' })

  await expect(page.getByTestId('context-menu')).toBeVisible()
  await expect(page.getByTestId('menu-paste')).toBeVisible()
  await expect(page.getByTestId('menu-select-all')).toBeVisible()
  await expect(page.getByTestId('menu-zoom-to-fit')).toBeVisible()

  // Escape closes it — R-A11Y-001.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('context-menu')).toHaveCount(0)
})

test('bring to front and send to back reorder — the FR-CANVAS-016 slice', async ({
  page,
}) => {
  await drawShape(page, 'rect', 300, 300, 420, 400)
  await drawShape(page, 'ellipse', 340, 330, 460, 430)
  await expect.poll(async () => (await objects(page)).length).toBe(2)

  const before = await objects(page)
  const first = before[0]!

  // Select the bottom object where the top one does not cover it, then bring
  // it forward.
  await page.getByTestId('tool-select').click()
  await page.mouse.click(310, 310)
  await expect.poll(() => selection(page)).toEqual([first.id])

  await page.mouse.click(310, 310, { button: 'right' })
  await page.getByTestId('menu-bring-to-front').click()

  // __coboardObjects returns z-order, so the moved object is now last.
  await expect.poll(async () => (await objects(page)).at(-1)!.id).toBe(first.id)
})

test('alignment guides snap a drag to a neighbour — FR-CANVAS-020', async ({ page }) => {
  await drawShape(page, 'rect', 300, 200, 400, 260)
  await drawShape(page, 'rect', 300, 400, 400, 460)
  await expect.poll(async () => (await objects(page)).length).toBe(2)

  const [anchor, mover] = await objects(page)

  // Nudge the second rect a few pixels out of alignment, then drag it back
  // to within the 6 px threshold and let the guide finish the job.
  await page.getByTestId('tool-select').click()
  await page.mouse.click(350, 430)
  await expect.poll(async () => (await selection(page)).length).toBe(1)

  await page.mouse.move(350, 430)
  await page.mouse.down()
  await page.mouse.move(354, 430, { steps: 4 })
  await page.mouse.up()

  const after = await objects(page)
  const moved = after.find(o => o.id === mover!.id)!
  // Snapped back onto the anchor's left edge rather than sitting 4 px off it.
  expect(Math.abs(moved.x - anchor!.x)).toBeLessThan(1)
})

test('Ctrl disables snapping — FR-CANVAS-020', async ({ page }) => {
  await drawShape(page, 'rect', 300, 200, 400, 260)
  await drawShape(page, 'rect', 300, 400, 400, 460)
  await expect.poll(async () => (await objects(page)).length).toBe(2)

  const [anchor, mover] = await objects(page)

  await page.getByTestId('tool-select').click()
  await page.mouse.click(350, 430)
  await page.mouse.move(350, 430)
  await page.mouse.down()
  await page.keyboard.down('Control')
  await page.mouse.move(354, 430, { steps: 4 })
  await page.keyboard.up('Control')
  await page.mouse.up()

  const moved = (await objects(page)).find(o => o.id === mover!.id)!
  // Left where the user put it — 4 px off, not snapped.
  expect(Math.abs(moved.x - anchor!.x)).toBeGreaterThan(2)
})

test('the properties panel follows each tool — FLOWS §14.4', async ({ page }) => {
  await page.getByTestId('tool-rect').click()
  await expect(page.getByTestId('properties-panel')).toHaveAttribute(
    'data-context',
    'rect',
  )
  await expect(page.getByTestId('shape-properties')).toBeVisible()
  // Rect alone gets a corner radius.
  await expect(page.getByTestId('shape-radius-slider')).toBeVisible()

  await page.getByTestId('tool-line').click()
  await expect(page.getByTestId('shape-radius-slider')).toHaveCount(0)

  await page.getByTestId('tool-sticky').click()
  await expect(page.getByTestId('sticky-properties')).toBeVisible()

  await page.getByTestId('tool-text').click()
  await expect(page.getByTestId('text-properties')).toBeVisible()
  await expect(page.getByTestId('text-bold')).toBeVisible()
})

test('shape colours from the panel land on the object', async ({ page }) => {
  await page.getByTestId('tool-rect').click()
  await page.getByRole('button', { name: 'Stroke colour #EF4444' }).click()
  await page.getByRole('button', { name: 'Fill colour #EAB308' }).click()

  await page.mouse.move(300, 300)
  await page.mouse.down()
  await page.mouse.move(420, 380, { steps: 6 })
  await page.mouse.up()

  await expect.poll(async () => (await objects(page)).length).toBe(1)
  const [o] = await objects(page)
  expect(o!.stroke!.toUpperCase()).toBe('#EF4444')
  expect(o!.fill!.toUpperCase()).toBe('#EAB308')
})

test('shapes transform with the Phase 4 toolkit', async ({ page }) => {
  await drawShape(page, 'ellipse', 300, 300, 420, 380)
  await expect.poll(async () => (await objects(page)).length).toBe(1)
  const [before] = await objects(page)

  await page.getByTestId('tool-select').click()
  await page.mouse.click(360, 340)
  await expect.poll(async () => (await selection(page)).length).toBe(1)

  // Drag it.
  await page.mouse.move(360, 340)
  await page.mouse.down()
  await page.mouse.move(500, 500, { steps: 8 })
  await page.mouse.up()

  const [after] = await objects(page)
  expect(after!.x).toBeGreaterThan(before!.x + 100)
})
