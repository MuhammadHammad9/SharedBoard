/**
 * @vitest-environment happy-dom
 *
 * Image upload — FR-CANVAS-010, FLOWS E-05, PRD §8.2.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_UPLOAD_BYTES } from '@coboard/shared'
import type { PutFile } from '../uploadEngine.js'

const lib = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock('../../../lib/api.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../lib/api.js')>()),
  api: { post: lib.post },
}))

const engine = await import('../uploadEngine.js')
const { boardStore } = await import('../../../stores/boardStore.js')
const { errors } = await import('../../../lib/strings.js')

const BOARD = '00000000-0000-4000-8000-000000000001'
const file = (type: string, size = 2048, name = 'cat.png') => {
  const f = new File([new Uint8Array(Math.min(size, 16))], name, { type })
  Object.defineProperty(f, 'size', { value: size })
  return f
}
const items = () => Object.values(engine.useUploadStore.getState().items)
const flush = () => new Promise(r => setTimeout(r, 0))

let notify: ReturnType<typeof vi.fn<(message: string) => void>>
let put: ReturnType<typeof vi.fn<PutFile>>

beforeEach(() => {
  boardStore.getState().loadObjects([])
  boardStore.getState().setReadOnly(false)
  engine.useUploadStore.setState({ items: {} })
  lib.post.mockReset()
  notify = vi.fn()
  put = vi.fn(async (_url, _file, _headers, onProgress: (f: number) => void) => {
    onProgress(0.5)
    onProgress(1)
  })
  engine.setPutFile(put)
  engine.setUploadContext({
    boardId: BOARD,
    notify,
    visibleArea: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
  })
})

afterEach(() => {
  engine.setPutFile(null)
  engine.setUploadContext(null)
})

describe('checks the file before any request — E-05', () => {
  it('a 50 MB image is refused with the PRD copy, and nothing is requested', async () => {
    await engine.startUploads([file('image/png', 50 * 1024 * 1024)])
    expect(notify).toHaveBeenCalledWith(errors.uploadTooLarge)
    expect(lib.post).not.toHaveBeenCalled()
    expect(items()).toHaveLength(0)
  })

  it('an unsupported type is refused with the PRD copy', async () => {
    await engine.startUploads([file('application/pdf', 100, 'doc.pdf')])
    expect(notify).toHaveBeenCalledWith(errors.unsupportedFile)
    expect(lib.post).not.toHaveBeenCalled()
  })

  it('exactly 10 MB is allowed', () => {
    expect(engine.rejectionFor(file('image/png', MAX_UPLOAD_BYTES))).toBeNull()
  })

  it('a viewer cannot upload at all', async () => {
    boardStore.getState().setReadOnly(true)
    await engine.startUploads([file('image/png')])
    expect(items()).toHaveLength(0)
    expect(lib.post).not.toHaveBeenCalled()
  })
})

describe('placement — D13-5', () => {
  it('keeps natural size when it fits, centred on the point', () => {
    expect(
      engine.placeBox(
        { width: 200, height: 100 },
        { x: 500, y: 400 },
        {
          x: 0,
          y: 0,
          width: 1000,
          height: 800,
        },
      ),
    ).toEqual({ x: 400, y: 350, width: 200, height: 100 })
  })

  it('scales a large image down to 60% of the view, keeping its aspect', () => {
    const box = engine.placeBox(
      { width: 4000, height: 2000 },
      { x: 0, y: 0 },
      { x: 0, y: 0, width: 1000, height: 800 },
    )
    expect(box.width).toBe(600)
    expect(box.height).toBe(300)
  })
})

describe('the pipeline', () => {
  it('presign → PUT → confirm → ONE create op carrying the URL', async () => {
    lib.post
      .mockResolvedValueOnce({
        uploadUrl: 'https://s3/put',
        key: `boards/${BOARD}/x.png`,
        headers: { 'content-type': 'image/png' },
      })
      .mockResolvedValueOnce({ url: 'https://cdn/x.png' })

    await engine.startUploads([file('image/png')], { x: 100, y: 100 })
    await flush()
    await flush()

    expect(lib.post).toHaveBeenNthCalledWith(1, '/uploads/presign', {
      boardId: BOARD,
      filename: 'cat.png',
      contentType: 'image/png',
      size: 2048,
    })
    expect(put).toHaveBeenCalledWith(
      'https://s3/put',
      expect.any(File),
      { 'content-type': 'image/png' },
      expect.any(Function),
    )
    const objects = [...boardStore.getState().objects.values()]
    expect(objects).toHaveLength(1)
    expect(objects[0]).toMatchObject({ type: 'image', url: 'https://cdn/x.png' })
    // Never base64 — FR-CANVAS-010.
    expect(JSON.stringify(objects[0])).not.toContain('data:')
  })

  it('a failure leaves the placeholder with Retry; Retry succeeds; nothing was created before', async () => {
    lib.post.mockRejectedValueOnce(new Error('network'))
    await engine.startUploads([file('image/png')])
    await flush()
    expect(items()[0]!.status).toBe('failed')
    expect(boardStore.getState().objects.size).toBe(0)

    lib.post
      .mockResolvedValueOnce({
        uploadUrl: 'u',
        key: `boards/${BOARD}/y.png`,
        headers: {},
      })
      .mockResolvedValueOnce({ url: 'https://cdn/y.png' })
    engine.retryUpload(items()[0]!.id)
    await flush()
    await flush()
    expect(boardStore.getState().objects.size).toBe(1)
  })

  it('Remove while uploading means nothing is created', async () => {
    let release!: () => void
    put.mockImplementationOnce(() => new Promise<void>(r => (release = r)))
    lib.post
      .mockResolvedValueOnce({
        uploadUrl: 'u',
        key: `boards/${BOARD}/z.png`,
        headers: {},
      })
      .mockResolvedValueOnce({ url: 'https://cdn/z.png' })

    await engine.startUploads([file('image/png')])
    await flush()
    engine.removeUpload(items()[0]!.id)
    release()
    await flush()
    await flush()
    expect(boardStore.getState().objects.size).toBe(0)
  })
})

describe('uploads belong to their board', () => {
  const OTHER = '00000000-0000-4000-8000-000000000002'

  it('an upload finishing after a board switch creates nothing on the new board', async () => {
    let finishPut: () => void = () => {}
    put.mockImplementationOnce(() => new Promise<void>(r => (finishPut = r)))
    lib.post
      .mockResolvedValueOnce({ uploadUrl: 'https://s3/put', key: 'k', headers: {} })
      .mockResolvedValueOnce({ url: 'https://cdn/x.png' })

    await engine.startUploads([file('image/png')], { x: 0, y: 0 })
    await flush()
    expect(items()).toHaveLength(1)

    // Leave for another board while the bytes are still going up.
    engine.setUploadContext(null)
    boardStore.getState().loadObjects([])
    engine.setUploadContext({
      boardId: OTHER,
      notify,
      visibleArea: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
    })
    expect(items()).toHaveLength(0)

    finishPut()
    await flush()
    await flush()
    expect(boardStore.getState().objects.size).toBe(0)
  })

  it('tags each item with its board and refuses to commit into a different one', async () => {
    let finishPut: () => void = () => {}
    put.mockImplementationOnce(() => new Promise<void>(r => (finishPut = r)))
    lib.post
      .mockResolvedValueOnce({ uploadUrl: 'https://s3/put', key: 'k', headers: {} })
      .mockResolvedValueOnce({ url: 'https://cdn/x.png' })

    await engine.startUploads([file('image/png')], { x: 0, y: 0 })
    await flush()
    expect(items()[0]).toMatchObject({ boardId: BOARD })

    // Switched straight to another board, with no null in between.
    engine.setUploadContext({
      boardId: OTHER,
      notify,
      visibleArea: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
    })
    finishPut()
    await flush()
    await flush()
    expect(boardStore.getState().objects.size).toBe(0)
  })
})
