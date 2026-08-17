import {
  BoardObjectSchema,
  clampCoord,
  type BoardObject,
  type ObjectId,
} from '@coboard/shared'

/**
 * Copy / cut / paste / duplicate — FR-CANVAS-015, FLOWS E-06.
 *
 * Two channels, deliberately:
 *
 *   1. The SYSTEM clipboard, carrying a JSON payload. This is what makes
 *      cross-tab paste work, which the requirement calls for explicitly.
 *   2. An in-memory fallback in the store. Reading the system clipboard can be
 *      denied by permission policy or unavailable outside a secure context,
 *      and copy/paste silently ceasing to work inside a single tab would be a
 *      worse failure than not supporting cross-tab at all.
 *
 * Everything read back from the system clipboard is UNTRUSTED. It is text a
 * user can hand-edit, or that another site wrote. It goes through Zod before
 * it is allowed anywhere near the store (R-SEC-003) — the same discipline the
 * socket boundary gets in Phase 9, for the same reason.
 */

/** Marks a payload as ours, so foreign JSON is ignored rather than parsed. */
const MAGIC = 'coboard/objects@1'

interface ClipboardPayload {
  kind: typeof MAGIC
  /** `unknown` on the way back in — everything read here is untrusted. */
  objects: readonly unknown[]
}

/** FR-CANVAS-015: "duplicate offsets by +16, +16 canvas px". */
export const DUPLICATE_OFFSET = 16

export const serialize = (objects: readonly BoardObject[]): string =>
  JSON.stringify({ kind: MAGIC, objects } satisfies ClipboardPayload)

/**
 * Parse a clipboard string into board objects.
 *
 * Returns `[]` for anything that is not a valid CoBoard payload — including
 * valid JSON from another application, and our own payload with one corrupt
 * object. A partially-valid payload yields only the objects that pass; the
 * alternative is refusing an entire paste because one member is malformed.
 */
export function deserialize(raw: string): BoardObject[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as ClipboardPayload).kind !== MAGIC ||
    !Array.isArray((parsed as ClipboardPayload).objects)
  ) {
    return []
  }

  const out: BoardObject[] = []
  for (const candidate of (parsed as ClipboardPayload).objects) {
    // R-SEC-003: reject, never coerce. R-SEC-004's finite bounds are inside
    // the schema, so an Infinity coordinate cannot reach the renderer here
    // any more than it can over the socket.
    const result = BoardObjectSchema.safeParse(candidate)
    if (result.success) out.push(result.data)
  }
  return out
}

/**
 * Re-key objects for pasting.
 *
 * FR-CANVAS-015: "Pasted objects get NEW IDs. Never reuse an ID." Reusing one
 * would make the paste an update to the original the moment Phase 9 sends it
 * to the server — the user would watch their copy move the original instead of
 * appearing beside it.
 *
 * `zIndexFor` is called per object so the caller can allocate fresh top-of-
 * stack keys without this module needing to know about the store.
 */
export function rekey(
  objects: readonly BoardObject[],
  offsetX: number,
  offsetY: number,
  zIndexFor: () => string,
): BoardObject[] {
  const now = Date.now()
  return objects.map(o => ({
    ...o,
    id: crypto.randomUUID() as ObjectId,
    x: clampCoord(o.x + offsetX),
    y: clampCoord(o.y + offsetY),
    zIndex: zIndexFor(),
    createdAt: now,
    updatedAt: now,
    ...(o.type === 'stroke'
      ? {
          points: o.points.map((v, i) =>
            i % 3 === 0
              ? clampCoord(v + offsetX)
              : i % 3 === 1
                ? clampCoord(v + offsetY)
                : v,
          ),
        }
      : {}),
  })) as BoardObject[]
}

/** Write to the system clipboard. Never throws — a blocked write is not fatal. */
export async function writeSystemClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard?.writeText(text)
    return true
  } catch {
    // Denied, insecure context, or no clipboard at all. The in-memory
    // fallback still holds the objects.
    return false
  }
}

/** Read the system clipboard. Returns null when unavailable or denied. */
export async function readSystemClipboard(): Promise<string | null> {
  try {
    const text = await navigator.clipboard?.readText()
    return text ?? null
  } catch {
    return null
  }
}
