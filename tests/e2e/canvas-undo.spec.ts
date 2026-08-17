import { expect, test, type Page } from '@playwright/test'

/**
 * Undo and redo end to end — FR-CANVAS-018, PRD §11.5 AT-42/43/44,
 * FLOWS §8.2.5.
 *
 * The unit suite proves the stack semantics against the real store. What only
 * a browser can prove is that the keyboard reaches them, that the buttons
 * reflect the stacks, and that a real pointer gesture produces the one entry
 * TRD §8.4 says it should — the grouping bugs all live in the handlers, not in
 * HistoryManager.
 */

const BOARD = '/?debug=1'

interface TestObject {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  color?: string
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

const stacks = (page: Page): Promise<{ undo: number; redo: number }> =>
  page.evaluate(() =>
    (
      window as unknown as { __coboardHistory: () => { undo: number; redo: number } }
    ).__coboardHistory(),
  )

/**
 * A stable state hash, the same idea as the ?debug=1 overlay's. "The board
 * returned to its starting state" only means something if the comparison is
 * over the whole document rather than an object count.
 */
async function hash(page: Page): Promise<string> {
  const list = await objects(page)
  return JSON.stringify(
    list
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map(o => [o.id, o.type, Math.round(o.x * 100), Math.round(o.y * 100), o.zIndex]),
  )
}

/** Draw one freehand stroke. One user action, and so one undo entry. */
async function drawStroke(page: Page, x: number, y: number) {
  await page.getByTestId('tool-pen').click()
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + i * 8, y + i * 5)
  await page.mouse.up()
}

test.beforeEach(async ({ page }) => {
  await page.goto(BOARD)
  await surface(page)
  await page.getByTestId('tool-select').click()
})

test('the controls mirror the two stacks — FLOWS §14.2', async ({ page }) => {
  const undo = page.getByTestId('undo-button')
  const redo = page.getByTestId('redo-button')

  await expect(undo).toHaveAttribute('aria-disabled', 'true')
  await expect(redo).toHaveAttribute('aria-disabled', 'true')

  await drawStroke(page, 200, 200)
  await expect(undo).toHaveAttribute('aria-disabled', 'false')
  await expect(redo).toHaveAttribute('aria-disabled', 'true')

  await undo.click()
  await expect(undo).toHaveAttribute('aria-disabled', 'true')
  await expect(redo).toHaveAttribute('aria-disabled', 'false')

  await redo.click()
  await expect.poll(async () => (await objects(page)).length).toBe(1)
})

test('AT-42: ten actions, ten undos, back to the starting state', async ({ page }) => {
  const before = await hash(page)

  for (let i = 0; i < 10; i++) await drawStroke(page, 150 + i * 55, 180)

  await expect.poll(async () => (await objects(page)).length).toBe(10)
  // TRD §8.4: one stroke is one entry. Ten strokes must not be sixty.
  expect(await stacks(page)).toEqual({ undo: 10, redo: 0 })

  await page.getByTestId('canvas-surface').click({ position: { x: 700, y: 500 } })
  for (let i = 0; i < 10; i++) await page.keyboard.press('Control+z')

  await expect.poll(() => hash(page)).toBe(before)
  await expect(page.getByTestId('undo-button')).toHaveAttribute('aria-disabled', 'true')
})

test('AT-43: five undos then five redos is identical to before', async ({ page }) => {
  for (let i = 0; i < 5; i++) await drawStroke(page, 150 + i * 90, 200)
  await expect.poll(async () => (await objects(page)).length).toBe(5)
  const before = await hash(page)

  await page.getByTestId('tool-select').click()
  for (let i = 0; i < 5; i++) await page.keyboard.press('Control+z')
  await expect.poll(async () => (await objects(page)).length).toBe(0)

  for (let i = 0; i < 5; i++) await page.keyboard.press('Control+Shift+z')
  await expect.poll(() => hash(page)).toBe(before)
})

test('AT-44: undo, a new action, then redo does nothing', async ({ page }) => {
  await drawStroke(page, 200, 200)
  await drawStroke(page, 400, 200)
  await page.getByTestId('tool-select').click()

  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await objects(page)).length).toBe(1)
  expect((await stacks(page)).redo).toBe(1)

  // R-UNDO-008: any new action clears redo. Always.
  await drawStroke(page, 600, 200)
  expect((await stacks(page)).redo).toBe(0)
  await expect(page.getByTestId('redo-button')).toHaveAttribute('aria-disabled', 'true')

  const after = await hash(page)
  await page.getByTestId('tool-select').click()
  await page.keyboard.press('Control+Shift+z')
  await expect.poll(() => hash(page)).toBe(after)
})

test('a drag of a multi-selection is ONE undo — R-UNDO-004', async ({ page }) => {
  await drawStroke(page, 200, 200)
  await drawStroke(page, 400, 200)
  await page.getByTestId('tool-select').click()
  await page.keyboard.press('Control+a')

  const before = await objects(page)

  // Drag the whole selection by grabbing one of its members.
  await page.mouse.move(210, 205)
  await page.mouse.down()
  await page.mouse.move(310, 305, { steps: 8 })
  await page.mouse.up()

  await expect.poll(async () => (await objects(page))[0]!.x).not.toBe(before[0]!.x)
  expect((await stacks(page)).undo).toBe(3) // two strokes, one drag

  await page.keyboard.press('Control+z')
  // One keypress puts BOTH back.
  await expect
    .poll(async () => (await objects(page)).map(o => Math.round(o.x)))
    .toEqual(before.map(o => Math.round(o.x)))
})

test('delete is undoable and restores the object whole — FR-CANVAS-014', async ({
  page,
}) => {
  await drawStroke(page, 300, 250)
  await page.getByTestId('tool-select').click()
  await page.keyboard.press('Control+a')
  const before = await hash(page)

  await page.keyboard.press('Delete')
  await expect.poll(async () => (await objects(page)).length).toBe(0)

  await page.keyboard.press('Control+z')
  await expect.poll(() => hash(page)).toBe(before)
})

test('an eraser sweep across several objects is ONE undo', async ({ page }) => {
  await drawStroke(page, 200, 300)
  await drawStroke(page, 320, 300)
  await drawStroke(page, 440, 300)
  await expect.poll(async () => (await objects(page)).length).toBe(3)
  const before = await hash(page)

  await page.getByTestId('tool-eraser').click()
  await page.mouse.move(205, 305)
  await page.mouse.down()
  await page.mouse.move(325, 305, { steps: 12 })
  await page.mouse.move(445, 305, { steps: 12 })
  await page.mouse.up()

  await expect.poll(async () => (await objects(page)).length).toBe(0)
  expect((await stacks(page)).undo).toBe(4) // three strokes, one sweep

  await page.getByTestId('tool-select').click()
  await page.keyboard.press('Control+z')
  await expect.poll(() => hash(page)).toBe(before)
})

test('R-A11Y-009: Cmd+Z belongs to the textarea while text is being edited', async ({
  page,
}) => {
  // A committed stroke, so the board's undo stack has something to lose.
  await drawStroke(page, 200, 200)
  expect((await stacks(page)).undo).toBe(1)

  await page.getByTestId('tool-sticky').click()
  await page.mouse.click(500, 350)

  const editor = page.getByTestId('text-overlay-input')
  await expect(editor).toBeFocused()
  await editor.fill('hello')

  /*
   * The canvas shortcut must NOT fire here. If it did, the stroke would
   * disappear from under a user who meant to undo their own typing — which is
   * exactly the failure R-A11Y-009 exists to prevent.
   *
   * The keypress reaching the textarea's own undo instead is the correct
   * outcome, and it empties the note, so the text is retyped before the exit.
   */
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await objects(page)).length).toBe(2)
  expect((await stacks(page)).undo).toBe(1)

  await editor.fill('hello again')
  await page.keyboard.press('Escape')

  // Committing the note is the second entry — one CREATE carrying its text.
  await expect.poll(async () => (await objects(page)).length).toBe(2)
  expect((await stacks(page)).undo).toBe(2)

  await page.getByTestId('tool-select').click()
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await objects(page)).length).toBe(1)
})

test('history does not survive a reload — R-UNDO-006', async ({ page }) => {
  await drawStroke(page, 250, 250)
  expect((await stacks(page)).undo).toBe(1)

  await page.reload()
  await surface(page)

  // The board is empty again anyway at this phase; what matters is that the
  // stack is too, rather than holding entries naming objects that are gone.
  expect(await stacks(page)).toEqual({ undo: 0, redo: 0 })
  await expect(page.getByTestId('undo-button')).toHaveAttribute('aria-disabled', 'true')
})
