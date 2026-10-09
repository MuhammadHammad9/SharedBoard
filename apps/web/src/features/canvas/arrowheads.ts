import type { BoardObject } from '@coboard/shared'
import type { ArrowheadStyle } from '../../stores/boardStore.js'

/**
 * Arrowhead style — FLOWS §14.4, "Line / Arrow — … arrowhead style
 * (start/end/both/none)". Stored as the two booleans the schema already has
 * (`arrowStart`, `arrowEnd`); this is the four-way view of them.
 *
 * An absent `arrowEnd` keeps the renderer's existing default — an arrow has a
 * head at its end, a line has none — so objects stored before the control
 * existed read exactly as they draw.
 */
export type Arrowheads = ArrowheadStyle

export const ARROWHEADS: readonly Arrowheads[] = ['none', 'start', 'end', 'both']

export function arrowheadsOf(o: BoardObject): Arrowheads | undefined {
  if (o.type !== 'line' && o.type !== 'arrow') return undefined
  const start = o.arrowStart ?? false
  const end = o.arrowEnd ?? o.type === 'arrow'
  return start && end ? 'both' : start ? 'start' : end ? 'end' : 'none'
}

export const arrowFlags = (style: Arrowheads) => ({
  arrowStart: style === 'start' || style === 'both',
  arrowEnd: style === 'end' || style === 'both',
})

export function withArrowheads(o: BoardObject, style: Arrowheads): BoardObject {
  if (o.type !== 'line' && o.type !== 'arrow') return o
  return { ...o, ...arrowFlags(style) }
}
