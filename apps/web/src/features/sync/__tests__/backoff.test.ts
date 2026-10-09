import { describe, expect, it } from 'vitest'
import { backoffCeiling, backoffFor } from '../backoff.js'

/** Full-jitter backoff — R-SYNC-030, TRD §10.2, FLOWS §9.4. */

describe('backoff', () => {
  it('follows the FLOWS §9.4 curve: 1, 2, 4, 8, 16, then 30 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(backoffCeiling)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ])
  })

  it('stays inside [0, min(2^(n-1)·1000, 30000)]', () => {
    for (let attempt = 1; attempt <= 12; attempt++) {
      for (let i = 0; i < 50; i++) {
        const delay = backoffFor(attempt)
        expect(delay).toBeGreaterThanOrEqual(0)
        expect(delay).toBeLessThanOrEqual(backoffCeiling(attempt))
      }
    }
  })

  it('is FULL jitter — the extremes of the window are both reachable', () => {
    expect(backoffFor(5, () => 0)).toBe(0)
    expect(backoffFor(5, () => 0.999999)).toBeCloseTo(16_000, -1)
  })

  it('spreads real samples rather than returning a fixed sequence', () => {
    const samples = Array.from({ length: 200 }, () => backoffFor(5))
    expect(new Set(samples).size).toBeGreaterThan(150)
    expect(samples.some(d => d < 4_000)).toBe(true)
    expect(samples.some(d => d > 12_000)).toBe(true)
  })

  it('caps the growth, and never overflows on a very long outage', () => {
    expect(backoffCeiling(1_000)).toBe(30_000)
    expect(Number.isFinite(backoffFor(1_000))).toBe(true)
  })
})
