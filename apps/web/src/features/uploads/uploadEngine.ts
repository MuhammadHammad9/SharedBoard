import { create } from 'zustand'
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_UPLOAD_BYTES,
  clampCoord,
  type ImageObject,
  type ObjectId,
  type Rect,
} from '@coboard/shared'
import { api } from '../../lib/api.js'
import { errors } from '../../lib/strings.js'
import { boardStore, nextZIndex } from '../../stores/boardStore.js'
import { applyAndEmit, createOps } from '../canvas/history/apply.js'
import { LABELS } from '../canvas/history/grouping.js'
import { imageCache } from '../canvas/imageCache.js'

const CROSSFADE_MS = 200

/**
 * Image upload — FR-CANVAS-010, TRD §4.4, FLOWS E-05.
 *
 *   check the file HERE first (E-05: never upload 50 MB to be told no)
 *     → a placeholder appears at the drop point, with a progress ring
 *     → presign → PUT straight to storage (XHR, for progress) → confirm
 *     → ONE create op carrying the URL, never base64 — and the placeholder
 *       goes
 *
 * A failure leaves the placeholder with "Upload failed." and Retry / Remove
 * (PRD §8.2). Nothing reaches the board — no op, no history entry — until
 * the server has confirmed the bytes, so a failed upload never has to be
 * rolled back for anyone else.
 *
 * Plain TypeScript with a small store, not React state: the placeholders are
 * read by one overlay component, and the toolbar, drop and paste paths all
 * start uploads without owning any of it.
 */

/** `done`: the object exists; the placeholder is fading out over the image. */
export type UploadStatus = 'uploading' | 'failed' | 'done'

export interface UploadItem {
  id: ObjectId
  file: File
  /** Where the image will sit — canvas coordinates (R-COORD-002). */
  box: Rect
  naturalWidth: number
  naturalHeight: number
  /** 0…1 of the bytes sent. */
  progress: number
  status: UploadStatus
}

interface UploadState {
  items: Record<string, UploadItem>
}

export const useUploadStore = create<UploadState>(() => ({ items: {} }))

const patch = (id: string, change: Partial<UploadItem>) =>
  useUploadStore.setState(s => {
    const item = s.items[id]
    return item ? { items: { ...s.items, [id]: { ...item, ...change } } } : s
  })

const drop = (id: string) =>
  useUploadStore.setState(s => {
    const { [id]: _gone, ...rest } = s.items
    return { items: rest }
  })

/* ── Context: who is uploading where, set by the board route ─────────────── */

export interface UploadContext {
  boardId: string
  /** A toast. */
  notify: (message: string) => void
  /** The visible area, in canvas coordinates — for placement (D13-5). */
  visibleArea: () => Rect
}

let context: UploadContext | null = null

export function setUploadContext(next: UploadContext | null): void {
  context = next
}

/* ── Transport: XHR for upload progress; swappable in tests ──────────────── */

export type PutFile = (
  url: string,
  file: File,
  headers: Record<string, string>,
  onProgress: (fraction: number) => void,
) => Promise<void>

const xhrPut: PutFile = (url, file, headers, onProgress) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value)
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) onProgress(e.loaded / e.total)
    }
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`PUT ${xhr.status}`))
    xhr.onerror = () => reject(new Error('PUT network error'))
    xhr.send(file)
  })

let putFile: PutFile = xhrPut

export function setPutFile(next: PutFile | null): void {
  putFile = next ?? xhrPut
}

/* ── Validation — E-05 and the PRD §8.2 copy ─────────────────────────────── */

/** The toast for a file that must not be uploaded, or null if it may. */
export function rejectionFor(file: File): string | null {
  if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type))
    return errors.unsupportedFile
  if (file.size > MAX_UPLOAD_BYTES) return errors.uploadTooLarge
  return null
}

/* ── Placement — D13-5 ───────────────────────────────────────────────────── */

/** Natural size, scaled down (never up) to fit 60% of the visible area. */
export function placeBox(
  natural: { width: number; height: number },
  centre: { x: number; y: number },
  visible: Rect,
): Rect {
  const maxW = visible.width * 0.6
  const maxH = visible.height * 0.6
  const scale = Math.min(1, maxW / natural.width, maxH / natural.height)
  const width = Math.max(1, natural.width * scale)
  const height = Math.max(1, natural.height * scale)
  return {
    x: clampCoord(centre.x - width / 2),
    y: clampCoord(centre.y - height / 2),
    width,
    height,
  }
}

/** Fallback when the browser cannot report a size (an SVG with no width). */
const DEFAULT_NATURAL = { width: 320, height: 240 }

async function naturalSize(file: File): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    return image.naturalWidth > 0 && image.naturalHeight > 0
      ? { width: image.naturalWidth, height: image.naturalHeight }
      : DEFAULT_NATURAL
  } catch {
    return DEFAULT_NATURAL
  } finally {
    URL.revokeObjectURL(url)
  }
}

/* ── The pipeline ────────────────────────────────────────────────────────── */

/**
 * Start uploading each file. `at` is the drop point in canvas coordinates;
 * without one (paste, toolbar) the images go to the centre of the view.
 */
export async function startUploads(
  files: readonly File[],
  at?: { x: number; y: number },
): Promise<void> {
  const ctx = context
  if (!ctx || boardStore.getState().readOnly) return

  const visible = ctx.visibleArea()
  const centre = at ?? {
    x: visible.x + visible.width / 2,
    y: visible.y + visible.height / 2,
  }

  let offset = 0
  for (const file of files) {
    const rejection = rejectionFor(file)
    if (rejection) {
      ctx.notify(rejection)
      continue
    }
    const natural = await naturalSize(file)
    // Several at once fan out a little, so they do not land exactly stacked.
    const box = placeBox(natural, { x: centre.x + offset, y: centre.y + offset }, visible)
    offset += 24
    const id = crypto.randomUUID() as ObjectId
    useUploadStore.setState(s => ({
      items: {
        ...s.items,
        [id]: {
          id,
          file,
          box,
          naturalWidth: natural.width,
          naturalHeight: natural.height,
          progress: 0,
          status: 'uploading',
        },
      },
    }))
    void run(id)
  }
}

export function retryUpload(id: string): void {
  patch(id, { status: 'uploading', progress: 0 })
  void run(id)
}

export function removeUpload(id: string): void {
  drop(id)
}

interface Presigned {
  uploadUrl: string
  key: string
  headers: Record<string, string>
}

async function run(id: string): Promise<void> {
  const item = useUploadStore.getState().items[id]
  const ctx = context
  if (!item || !ctx) return

  try {
    const signed = await api.post<Presigned>('/uploads/presign', {
      boardId: ctx.boardId,
      filename: item.file.name.slice(0, 255) || 'image',
      contentType: item.file.type,
      size: item.file.size,
    })
    await putFile(signed.uploadUrl, item.file, signed.headers, fraction =>
      patch(id, { progress: fraction }),
    )
    const { url } = await api.post<{ url: string }>('/uploads/confirm', {
      key: signed.key,
    })

    // Removed while uploading: the user said no, so nothing is created.
    if (!useUploadStore.getState().items[id]) return
    applyAndEmit(createOps([imageObject(id as ObjectId, item, url)]), LABELS.create)
    // Placeholder → loaded is a 200 ms crossfade (Phase 13 motion): keep the
    // placeholder until the bitmap has decoded, so there is no blank frame.
    await imageCache.whenSettled(url)
    patch(id, { status: 'done', progress: 1 })
    setTimeout(() => drop(id), CROSSFADE_MS)
  } catch {
    if (useUploadStore.getState().items[id]) patch(id, { status: 'failed' })
  }
}

function imageObject(id: ObjectId, item: UploadItem, url: string): ImageObject {
  const now = Date.now()
  return {
    id,
    type: 'image',
    x: item.box.x,
    y: item.box.y,
    width: item.box.width,
    height: item.box.height,
    rotation: 0,
    zIndex: nextZIndex(),
    opacity: 1,
    createdBy: 'local',
    createdAt: now,
    updatedAt: now,
    url,
    naturalWidth: item.naturalWidth,
    naturalHeight: item.naturalHeight,
    cornerRadius: 0,
  }
}
