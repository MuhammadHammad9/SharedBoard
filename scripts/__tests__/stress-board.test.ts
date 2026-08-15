import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { BoardObjectSchema, COORD_MAX, COORD_MIN } from '@coboard/shared'

/**
 * The 10,000-object stress board fixture.
 *
 * PRD risk R-2 requires it committed from week 1. R-PERF-025 requires every
 * performance claim to be measured against it — "it feels fast" on an empty
 * board is not evidence.
 */

const FIXTURE = resolve(import.meta.dirname, '../../fixtures/stress-board.json')

interface Fixture {
  seed: number
  objectCount: number
  objects: unknown[]
}

describe('fixtures/stress-board.json', () => {
  it('exists and is committed', () => {
    expect(existsSync(FIXTURE)).toBe(true)
  })

  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture

  it('contains exactly 10,000 objects', () => {
    expect(fixture.objects).toHaveLength(10_000)
    expect(fixture.objectCount).toBe(10_000)
  })

  it('validates EVERY object against the shared schema', () => {
    const failures: { index: number; error: string }[] = []
    fixture.objects.forEach((obj, index) => {
      const r = BoardObjectSchema.safeParse(obj)
      if (!r.success)
        failures.push({ index, error: r.error.issues[0]?.message ?? 'unknown' })
    })
    expect(failures.slice(0, 5)).toEqual([])
    expect(failures).toHaveLength(0)
  })

  it('keeps every coordinate inside the ±1,000,000 clamp', () => {
    for (const obj of fixture.objects as { x: number; y: number }[]) {
      expect(obj.x).toBeGreaterThanOrEqual(COORD_MIN)
      expect(obj.x).toBeLessThanOrEqual(COORD_MAX)
      expect(obj.y).toBeGreaterThanOrEqual(COORD_MIN)
      expect(obj.y).toBeLessThanOrEqual(COORD_MAX)
    }
  })

  it('uses unique object ids', () => {
    const ids = new Set((fixture.objects as { id: string }[]).map(o => o.id))
    expect(ids.size).toBe(fixture.objects.length)
  })

  it('uses STRING fractional z-indices that sort lexicographically — TRD §6.4', () => {
    const zs = (fixture.objects as { zIndex: string }[]).map(o => o.zIndex)
    expect(zs.every(z => typeof z === 'string')).toBe(true)
    const sorted = [...zs].sort()
    expect(sorted).toEqual(zs)
  })

  it('contains a realistic mix of object types, not one type repeated', () => {
    const types = new Set((fixture.objects as { type: string }[]).map(o => o.type))
    expect(types.size).toBeGreaterThanOrEqual(4)
    expect(types.has('stroke')).toBe(true)
    expect(types.has('sticky')).toBe(true)
  })

  it('is deterministic — records the seed that produced it', () => {
    expect(typeof fixture.seed).toBe('number')
  })
})
