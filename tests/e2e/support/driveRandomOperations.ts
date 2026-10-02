import type { Page } from '@playwright/test'

/**
 * The convergence driver — TRD §6.5, P11-T16.
 *
 * Seeded, so a divergence found on a CI run replays locally from the seed in
 * the failure message. Each step runs on both pages AT ONCE, so the two
 * clients genuinely race: both write, both hold unacked ops, both receive each
 * other's broadcasts mid-flight. Steps go through the real local write path
 * (`__coboardApplyLocal` → applyAndEmit → history → outbox → socket), and
 * undo/redo through the real history stack.
 *
 * The mix leans on UPDATEs to the same few objects, because concurrent writes
 * to the same field of the same object are where server-ordered LWW is
 * easiest to get wrong.
 */

export type Kind = 'create' | 'move' | 'recolour' | 'text' | 'delete' | 'undo' | 'redo'

const MIX: Array<[Kind, number]> = [
  ['create', 0.22],
  ['move', 0.22],
  ['recolour', 0.2],
  ['text', 0.1],
  ['delete', 0.08],
  ['undo', 0.12],
  ['redo', 0.06],
]

/** mulberry32. */
export function rng(seed: number): () => number {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pickKind(r: number): Kind {
  let acc = 0
  for (const [kind, weight] of MIX) {
    acc += weight
    if (r < acc) return kind
  }
  return 'move'
}

interface Step {
  kind: Kind
  r: [number, number, number]
  tag: string
}

/** One step, inside the page. Plain data in, nothing out. */
function runStep({ kind, r, tag }: Step): void {
  const w = window as unknown as {
    __coboardObjects: () => Array<Record<string, unknown> & { id: string; type: string }>
    __coboardApplyLocal: (ops: unknown[], label: string) => void
    __coboardUndo: () => boolean
    __coboardRedo: () => boolean
  }
  const STICKY = [
    '#FEF08A',
    '#FED7AA',
    '#FBCFE8',
    '#FECACA',
    '#E9D5FF',
    '#BFDBFE',
    '#BBF7D0',
    '#E4E4E7',
  ]
  const stickies = w.__coboardObjects().filter(o => o.type === 'sticky')
  // A small working set, so the two clients keep colliding on the same objects.
  const pool = stickies.slice(-6)
  const target = pool.length > 0 ? pool[Math.floor(r[0] * pool.length)]! : null
  const op = (type: string, objectId: string, payload: unknown) => ({
    id: crypto.randomUUID(),
    type,
    objectId,
    payload,
  })
  const now = Date.now()

  switch (kind) {
    case 'create': {
      const id = crypto.randomUUID()
      w.__coboardApplyLocal(
        [
          op('CREATE', id, {
            id,
            type: 'sticky',
            x: Math.round(r[1] * 1200),
            y: Math.round(r[2] * 800),
            width: 200,
            height: 200,
            rotation: 0,
            zIndex: `a${tag}`,
            opacity: 1,
            createdBy: 'convergence',
            createdAt: now,
            updatedAt: now,
            text: '',
            color: STICKY[Math.floor(r[1] * STICKY.length)],
            fontSize: 16,
            textAlign: 'left',
          }),
        ],
        'Create',
      )
      return
    }
    case 'move':
      if (!target) return
      w.__coboardApplyLocal(
        [
          op('UPDATE', target.id, {
            x: Math.round((target.x as number) + (r[1] - 0.5) * 200),
            y: Math.round((target.y as number) + (r[2] - 0.5) * 200),
            updatedAt: now,
          }),
        ],
        'Move',
      )
      return
    case 'recolour':
      if (!target) return
      w.__coboardApplyLocal(
        [
          op('UPDATE', target.id, {
            color: STICKY[Math.floor(r[1] * STICKY.length)],
            updatedAt: now,
          }),
        ],
        'Colour',
      )
      return
    case 'text':
      if (!target) return
      w.__coboardApplyLocal(
        [op('UPDATE', target.id, { text: `note ${tag}`, updatedAt: now })],
        'Typing',
      )
      return
    case 'delete':
      if (!target) return
      w.__coboardApplyLocal([op('DELETE', target.id, {})], 'Delete')
      return
    case 'undo':
      w.__coboardUndo()
      return
    case 'redo':
      w.__coboardRedo()
      return
  }
}

export interface DriveOptions {
  seed: number
  steps: number
  /** Called between steps — the chaos suites cut sockets here. */
  between?: (step: number) => Promise<void>
}

/** Drive `steps` operations per page, both pages concurrently. */
export async function driveRandomOperations(
  a: Page,
  b: Page,
  { seed, steps, between }: DriveOptions,
): Promise<void> {
  const random = rng(seed)
  const make = (side: string, i: number): Step => ({
    kind: pickKind(random()),
    r: [random(), random(), random()],
    // Unique per side and step, and lexicographically ordered for zIndex.
    tag: `${String(i).padStart(4, '0')}${side}`,
  })

  for (let i = 0; i < steps; i++) {
    const sa = make('a', i)
    const sb = make('b', i)
    await Promise.all([a.evaluate(runStep, sa), b.evaluate(runStep, sb)])
    // Let some ops pile up unacked, and let others round-trip: a few ms of
    // jitter between steps spreads the interleavings.
    if (random() < 0.3) await a.waitForTimeout(Math.floor(random() * 40))
    await between?.(i)
  }
}
