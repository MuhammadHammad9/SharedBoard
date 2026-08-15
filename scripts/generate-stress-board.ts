/**
 * Generates the 10,000-object stress board fixture.
 *
 * PRD risk R-2 (High/High): "a seeded 10k-object stress board committed to the
 * repo from week 1". R-PERF-025: every performance claim is measured against
 * it. "It feels fast" on an empty board is not evidence.
 *
 * The output is a committed FIXTURE, not a database seed — the Board and
 * Operation models do not exist until Phase 8, which then loads this file.
 *
 * Deterministic: a seeded PRNG so the fixture is byte-stable across runs and
 * diffs stay meaningful.
 *
 * Usage:
 *   pnpm fixtures:generate
 */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  PEN_COLOURS,
  STICKY_COLOUR_VALUES,
  STROKE_WIDTH_MAX,
  STROKE_WIDTH_MIN,
} from '../packages/shared/src/constants.js'
import type { BoardObject } from '../packages/shared/src/schemas/object.js'

const TARGET_COUNT = 10_000
const SEED = 20260815
const SPREAD = 12_000 // canvas units, well inside the ±1,000,000 clamp

/** Mulberry32 — small, fast, deterministic. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = mulberry32(SEED)
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!
const between = (min: number, max: number) => min + rand() * (max - min)
const round2 = (n: number) => Math.round(n * 100) / 100

/** Deterministic uuid v4-shaped identifier, derived from the seeded PRNG. */
function seededUuid(): string {
  const hex = '0123456789abcdef'
  let out = ''
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-'
    else if (i === 14) out += '4'
    else if (i === 19) out += hex[(Math.floor(rand() * 16) & 0x3) | 0x8]
    else out += hex[Math.floor(rand() * 16)]
  }
  return out
}

/**
 * Fractional z-index keys. TRD §6.4: a STRING ordered lexicographically, never
 * an integer. Fixed-width base-36 keeps the generated set correctly ordered.
 */
const zKey = (i: number) => `a${i.toString(36).padStart(6, '0')}`

const CREATOR = 'stress-fixture'
const NOW = 1_760_000_000_000

function makeStroke(i: number): BoardObject {
  const x = between(-SPREAD, SPREAD)
  const y = between(-SPREAD, SPREAD)
  const pointCount = Math.floor(between(8, 40))
  const points: number[] = []
  let px = x
  let py = y
  for (let p = 0; p < pointCount; p++) {
    px += between(-14, 14)
    py += between(-14, 14)
    points.push(round2(px), round2(py), round2(between(0.3, 1)))
  }
  const xs = points.filter((_, idx) => idx % 3 === 0)
  const ys = points.filter((_, idx) => idx % 3 === 1)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)

  return {
    id: seededUuid(),
    type: 'stroke',
    x: round2(minX),
    y: round2(minY),
    width: round2(Math.max(...xs) - minX),
    height: round2(Math.max(...ys) - minY),
    rotation: 0,
    zIndex: zKey(i),
    opacity: 1,
    createdBy: CREATOR,
    createdAt: NOW,
    updatedAt: NOW,
    points,
    color: pick(PEN_COLOURS),
    strokeWidth: Math.floor(between(STROKE_WIDTH_MIN, STROKE_WIDTH_MAX)),
    simplified: true,
  }
}

function makeShape(i: number): BoardObject {
  const type = pick(['rect', 'ellipse', 'line', 'arrow'] as const)
  const base = {
    id: seededUuid(),
    type,
    x: round2(between(-SPREAD, SPREAD)),
    y: round2(between(-SPREAD, SPREAD)),
    width: round2(between(40, 320)),
    height: round2(between(40, 240)),
    rotation: 0,
    zIndex: zKey(i),
    opacity: 1,
    createdBy: CREATOR,
    createdAt: NOW,
    updatedAt: NOW,
    stroke: pick(PEN_COLOURS),
    strokeWidth: Math.floor(between(STROKE_WIDTH_MIN, 6)),
    fill: rand() > 0.5 ? pick(PEN_COLOURS) : ('none' as const),
  }
  if (type === 'rect') return { ...base, type: 'rect', cornerRadius: rand() > 0.6 ? 8 : 0 }
  if (type === 'arrow') return { ...base, type: 'arrow', arrowStart: false, arrowEnd: true }
  return base as BoardObject
}

const STICKY_TEXTS = [
  'Ship the convergence harness first',
  'Latency budget: 250ms p95',
  'Who owns the outbox?',
  'Revisit after the offline test',
  'Blocked on share-link revocation',
  'Cursor interpolation feels good now',
  'Needs a decision from design',
  'Move to next sprint',
]

function makeSticky(i: number): BoardObject {
  return {
    id: seededUuid(),
    type: 'sticky',
    x: round2(between(-SPREAD, SPREAD)),
    y: round2(between(-SPREAD, SPREAD)),
    width: 200,
    height: 200,
    rotation: 0,
    zIndex: zKey(i),
    opacity: 1,
    createdBy: CREATOR,
    createdAt: NOW,
    updatedAt: NOW,
    text: pick(STICKY_TEXTS),
    color: pick(STICKY_COLOUR_VALUES),
    fontSize: 'auto',
    textAlign: 'center',
  }
}

const TEXT_SNIPPETS = [
  'Retro — Q3',
  'Sync engine',
  'Open questions',
  'Owner: Priya',
  'Parking lot',
  'Decisions',
]

function makeText(i: number): BoardObject {
  return {
    id: seededUuid(),
    type: 'text',
    x: round2(between(-SPREAD, SPREAD)),
    y: round2(between(-SPREAD, SPREAD)),
    width: round2(between(120, 420)),
    height: round2(between(24, 64)),
    rotation: 0,
    zIndex: zKey(i),
    opacity: 1,
    createdBy: CREATOR,
    createdAt: NOW,
    updatedAt: NOW,
    text: pick(TEXT_SNIPPETS),
    color: '#18181B',
    fontSize: Math.floor(between(14, 40)),
    bold: rand() > 0.7,
    italic: false,
    textAlign: 'left',
  }
}

/** Roughly the mix the personas describe: sticky-heavy, some drawing, some text. */
function makeObject(i: number): BoardObject {
  const r = rand()
  if (r < 0.45) return makeStroke(i)
  if (r < 0.75) return makeSticky(i)
  if (r < 0.92) return makeShape(i)
  return makeText(i)
}

const objects: BoardObject[] = []
for (let i = 0; i < TARGET_COUNT; i++) objects.push(makeObject(i))

const out = {
  $comment:
    'Deterministic 10,000-object stress board. PRD risk R-2, rule R-PERF-025. Regenerate with `pnpm fixtures:generate`.',
  seed: SEED,
  generatedBy: 'scripts/generate-stress-board.ts',
  name: 'Q3 Retrospective — stress fixture',
  objectCount: objects.length,
  objects,
}

const target = resolve(import.meta.dirname, '../fixtures/stress-board.json')
writeFileSync(target, JSON.stringify(out), 'utf8')

const counts = objects.reduce<Record<string, number>>((acc, o) => {
  acc[o.type] = (acc[o.type] ?? 0) + 1
  return acc
}, {})

console.log(`[stress-board] wrote ${objects.length} objects to ${target}`)
console.log('[stress-board] mix:', counts)
