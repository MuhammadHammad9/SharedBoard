import { expect, test } from '@playwright/test'
import { expectSettled, register, twoWindows } from './support/realtime.js'

/**
 * Image upload — FR-CANVAS-010, Phase 13. The real stack: the browser PUTs
 * straight to storage (the dev fake S3, D13-3) on a presigned URL, the server
 * confirms the bytes, and the op that reaches the other window carries a URL.
 */

test.describe.configure({ mode: 'serial' })

let email: string | null = null

/** A real 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

interface Img {
  type: string
  url?: string
}
const objects = (page: import('@playwright/test').Page) =>
  page.evaluate(() =>
    (window as unknown as { __coboardObjects: () => Img[] }).__coboardObjects(),
  )

test.beforeEach(async ({ page }) => {
  email ??= await register(page)
})

test('an image picked from the toolbar uploads, and the other window sees it', async ({
  browser,
}) => {
  const { a, b, contextA, contextB } = await twoWindows(browser, email!)

  await a.getByTestId('image-file-input').setInputFiles({
    name: 'diagram.png',
    mimeType: 'image/png',
    buffer: PNG,
  })

  await expect.poll(async () => (await objects(b)).length, { timeout: 15_000 }).toBe(1)
  const [image] = await objects(b)
  expect(image!.type).toBe('image')
  // A URL into storage — never base64 (FR-CANVAS-010).
  expect(image!.url).toMatch(/^http:\/\/127\.0\.0\.1:4569\/coboard\/boards\/.+\.png$/)
  // And the bytes are really there, loadable cross-origin.
  const fetched = await b.evaluate(async url => {
    const r = await fetch(url, { mode: 'cors' })
    return { ok: r.ok, type: r.headers.get('content-type') }
  }, image!.url!)
  expect(fetched).toEqual({ ok: true, type: 'image/png' })

  // The placeholder is gone once the image is on the board.
  await expect(a.getByTestId('upload-placeholder')).toHaveCount(0)
  await expectSettled(a, b)

  await contextA.close()
  await contextB.close()
})

test('E-05: an oversized image is refused before any upload', async ({ browser }) => {
  const { a, contextA, contextB } = await twoWindows(browser, email!)
  const requests: string[] = []
  a.on('request', r => {
    if (r.url().includes('/uploads/')) requests.push(r.url())
  })

  await a.getByTestId('image-file-input').setInputFiles({
    name: 'huge.png',
    mimeType: 'image/png',
    buffer: Buffer.alloc(11 * 1024 * 1024),
  })
  await expect(a.getByText('Images must be under 10 MB.')).toBeVisible()
  expect(requests).toEqual([])
  expect(await objects(a)).toHaveLength(0)

  await contextA.close()
  await contextB.close()
})
