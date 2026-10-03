import { EXPORT_URL_REVOKE_MS } from '@coboard/shared'

/**
 * The file name and the download — FLOWS §11, Phase 13 task 5.
 */

/**
 * `{board-name-slugified}`: accents folded ("Café" → "cafe"), anything that is
 * not a letter or digit becomes a hyphen, runs collapse, ends trimmed. Letters
 * outside Latin are KEPT (`Ünïcødé 看板` → `unicøde-看板`) — stripping them
 * would turn a Japanese board's name into nothing.
 */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '')
  return slug || 'board'
}

const pad = (n: number) => String(n).padStart(2, '0')

/** `{slug}-{YYYY-MM-DD}.png`, in the user's local date. */
export function exportFilename(boardName: string, now = new Date()): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  return `${slugify(boardName)}-${date}.png`
}

/** Blob → object URL → programmatic <a download> click → revoke after 60 s. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.append(a)
  a.click()
  a.remove()
  // Not revoked at once: some browsers start the download asynchronously and
  // would find the URL already gone.
  setTimeout(() => URL.revokeObjectURL(url), EXPORT_URL_REVOKE_MS)
}
