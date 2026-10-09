import type { AcceptedImageType } from '@coboard/shared'

/**
 * What a file actually is, from its first bytes — R-SEC-012.
 *
 * The browser's `File.type` comes from the extension, and the presign request
 * is whatever the client chose to send. Neither is evidence. A renamed
 * executable called `cat.png` claims `image/png` all the way to storage; only
 * the bytes say otherwise.
 */
export function sniffImageType(bytes: Uint8Array): AcceptedImageType | null {
  const at = (offset: number, ...sig: number[]) =>
    sig.every((b, i) => bytes[offset + i] === b)

  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (at(4, 0x37, 0x61) || at(4, 0x39, 0x61)))
    return 'image/gif'
  // RIFF....WEBP
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  if (looksLikeSvg(bytes)) return 'image/svg+xml'
  return null
}

/**
 * SVG is text, so there is no signature: it is SVG if the head is printable
 * UTF-8 with no NUL bytes and an `<svg` element opens within it, after any
 * BOM, XML declaration, doctype or comments.
 */
function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 4_096)
  if (head.includes(0)) return false
  const text = new TextDecoder('utf-8', { fatal: false }).decode(head)
  const stripped = text
    .replace(/^\uFEFF/, '')
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .trimStart()
  return /^<svg[\s>]/i.test(stripped)
}

/** The file extension stored in the key, so the URL says what it is. */
export const EXTENSION: Record<AcceptedImageType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}
