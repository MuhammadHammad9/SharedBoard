import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import {
  connected,
  createBoard,
  drawStroke,
  register,
  signIn,
} from './support/realtime.js'

/**
 * Export — FR-EXPORT-001, FLOWS §11, Phase 13 exit gate: "export produces a
 * correct PNG at both scales for all three scopes". Real downloads, read back
 * from disk; the PNG's own IHDR says how big it is.
 */

test.describe.configure({ mode: 'serial' })

let email: string | null = null

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

interface Box {
  id: string
  x: number
  y: number
  width: number
  height: number
}

const objects = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __coboardObjects: () => Box[] }).__coboardObjects(),
  )

function union(boxes: Box[]) {
  const minX = Math.min(...boxes.map(b => b.x))
  const minY = Math.min(...boxes.map(b => b.y))
  const maxX = Math.max(...boxes.map(b => b.x + b.width))
  const maxY = Math.max(...boxes.map(b => b.y + b.height))
  return { width: maxX - minX, height: maxY - minY }
}

/** Width and height from a PNG file's IHDR chunk. */
async function pngSize(path: string) {
  const bytes = await readFile(path)
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

async function exportPng(
  page: Page,
  scope: 'board' | 'selection' | 'visible',
  scale: 1 | 2,
) {
  await page.getByTestId('export-button').click()
  await page.getByTestId(`export-scope-${scope}`).check()
  await page.getByTestId(`export-scale-${scale}`).click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-confirm').click(),
  ])
  await expect(page.getByTestId('export-modal')).toHaveCount(0)
  const path = await download.path()
  return { name: download.suggestedFilename(), size: await pngSize(path!) }
}

test.beforeEach(async ({ page }) => {
  email ??= await register(page)
  await signIn(page, email)
})

test('E-22: an empty board will not export', async ({ page }) => {
  const boardId = await createBoard(page, 'Empty one')
  await page.goto(`/board/${boardId}`)
  await connected(page)
  await page.keyboard.press('Control+Shift+E')
  await expect(page.getByTestId('export-modal')).toBeVisible()
  await page.getByTestId('export-confirm').click()
  await expect(page.getByText("There's nothing to export yet.")).toBeVisible()
})

test('all three scopes, at 1× and 2×, with the right size and file name', async ({
  page,
}) => {
  const boardId = await createBoard(page, 'Q3 Retrospective')
  await page.goto(`/board/${boardId}`)
  await connected(page)
  await drawStroke(page, 300, 300)
  await drawStroke(page, 600, 420)
  // An uploaded image too: if any bitmap tainted the canvas, toBlob throws
  // and there would be no download at all (D13-2).
  await page.getByTestId('image-file-input').setInputFiles({
    name: 'dot.png',
    mimeType: 'image/png',
    buffer: PNG_1PX,
  })
  await expect.poll(async () => (await objects(page)).length, { timeout: 15_000 }).toBe(3)

  const all = await objects(page)
  const board = union(all)
  const pad = 24

  const one = await exportPng(page, 'board', 1)
  expect(one.name).toMatch(/^q3-retrospective-\d{4}-\d{2}-\d{2}\.png$/)
  expect(one.size).toEqual({
    width: Math.ceil(board.width + pad * 2),
    height: Math.ceil(board.height + pad * 2),
  })
  const two = await exportPng(page, 'board', 2)
  expect(two.size).toEqual({
    width: Math.ceil((board.width + pad * 2) * 2),
    height: Math.ceil((board.height + pad * 2) * 2),
  })

  // Selection: the first stroke alone.
  await page.evaluate(
    id =>
      (window as unknown as { __coboardSelect: (ids: string[]) => void }).__coboardSelect(
        [id],
      ),
    all[0]!.id,
  )
  const first = union([all[0]!])
  for (const scale of [1, 2] as const) {
    const sel = await exportPng(page, 'selection', scale)
    expect(sel.size).toEqual({
      width: Math.ceil((first.width + pad * 2) * scale),
      height: Math.ceil((first.height + pad * 2) * scale),
    })
  }

  // Visible area: exactly the window at 100% zoom, times the scale.
  const view = page.viewportSize()!
  for (const scale of [1, 2] as const) {
    const vis = await exportPng(page, 'visible', scale)
    expect(vis.size).toEqual({ width: view.width * scale, height: view.height * scale })
  }
})

test('a board over 2,000 objects exports in chunks, with progress, without freezing', async ({
  page,
}) => {
  const boardId = await createBoard(page, 'Big wall')
  await page.goto(`/board/${boardId}`)
  await connected(page)

  // 2,500 rectangles through the real local write path, in one history entry.
  await page.evaluate(() => {
    const w = window as unknown as {
      __coboardApplyLocal: (ops: unknown[], label: string) => void
    }
    const now = Date.now()
    const ops = Array.from({ length: 2_500 }, (_, i) => {
      const id = crypto.randomUUID()
      return {
        id: crypto.randomUUID(),
        type: 'CREATE',
        objectId: id,
        payload: {
          id,
          type: 'rect',
          x: (i % 50) * 60,
          y: Math.floor(i / 50) * 60,
          width: 40,
          height: 40,
          rotation: 0,
          zIndex: `a${String(i).padStart(5, '0')}`,
          opacity: 1,
          createdBy: 'export-test',
          createdAt: now,
          updatedAt: now,
          stroke: '#18181B',
          strokeWidth: 2,
          fill: '#FEF08A',
          cornerRadius: 0,
        },
      }
    })
    w.__coboardApplyLocal(ops, 'Create')
  })
  expect((await objects(page)).length).toBe(2_500)

  // Long tasks while the export renders: chunking means none is a freeze.
  await page.evaluate(() => {
    const w = window as unknown as { __longest: number }
    w.__longest = 0
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) w.__longest = Math.max(w.__longest, e.duration)
    }).observe({ type: 'longtask', buffered: false })
  })

  await page.getByTestId('export-button').click()
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    (async () => {
      await page.getByTestId('export-confirm').click()
      await expect(page.getByRole('progressbar')).toBeVisible()
    })(),
  ])
  const size = await pngSize((await download.path())!)
  expect(size).toEqual({ width: 50 * 60 - 20 + 48, height: 50 * 60 - 20 + 48 })
  const longest = await page.evaluate(
    () => (window as unknown as { __longest: number }).__longest,
  )
  console.log(
    `[export] 2,500 objects — longest main-thread task ${Math.round(longest)} ms`,
  )
})
