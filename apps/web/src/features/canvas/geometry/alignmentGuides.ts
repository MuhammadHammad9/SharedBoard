import type { BoardObject, Rect } from '@coboard/shared'

/**
 * Alignment guides — FR-CANVAS-020 [P1], FLOWS §8.2.3.
 *
 * While dragging, show a guide when an edge or centre of the dragged box lines
 * up with an edge or centre of some other object, within 6 SCREEN pixels — and
 * snap to it. Ctrl temporarily disables snapping.
 *
 * Screen pixels, not canvas units, and that is the whole subtlety. The
 * threshold describes how precisely a human can aim a pointer, which does not
 * change with zoom. A canvas-unit threshold would be unusably sticky at 500%
 * and useless at 10%.
 *
 * Checked only against NON-SELECTED objects within the viewport: an object
 * cannot align to itself, and an object nobody can see is not a landmark
 * anyone is aiming at.
 */

/** FR-CANVAS-020: "within 6 screen px". */
export const SNAP_THRESHOLD_PX = 6

/** A line the renderer draws, in canvas coordinates. */
export interface Guide {
  axis: 'x' | 'y'
  /** Canvas coordinate of the line. */
  position: number
  /** Extent along the other axis, so the guide spans both objects. */
  from: number
  to: number
}

export interface SnapResult {
  /** Canvas-space correction to apply to the dragged box. */
  dx: number
  dy: number
  guides: Guide[]
}

const NO_SNAP: SnapResult = { dx: 0, dy: 0, guides: [] }

/** The three interesting coordinates on each axis: near edge, centre, far edge. */
const xCandidates = (r: Rect): number[] => [r.x, r.x + r.width / 2, r.x + r.width]
const yCandidates = (r: Rect): number[] => [r.y, r.y + r.height / 2, r.y + r.height]

/**
 * Find the best snap for a dragged box against its neighbours.
 *
 * Returns the correction to apply plus the guides to draw. Only the single
 * closest candidate per axis is used: offering two competing horizontal snaps
 * at once would fight the user's pointer.
 */
export function findSnaps(
  box: Rect,
  others: readonly BoardObject[],
  zoom: number,
  enabled = true,
): SnapResult {
  if (!enabled || others.length === 0) return NO_SNAP

  // The threshold in canvas units, so the comparison below is all in one space.
  const threshold = SNAP_THRESHOLD_PX / zoom

  let bestX: { delta: number; position: number; other: Rect } | null = null
  let bestY: { delta: number; position: number; other: Rect } | null = null

  const boxX = xCandidates(box)
  const boxY = yCandidates(box)

  for (const o of others) {
    const other: Rect = { x: o.x, y: o.y, width: o.width, height: o.height }

    for (const target of xCandidates(other)) {
      for (const mine of boxX) {
        const delta = target - mine
        if (Math.abs(delta) > threshold) continue
        if (!bestX || Math.abs(delta) < Math.abs(bestX.delta)) {
          bestX = { delta, position: target, other }
        }
      }
    }

    for (const target of yCandidates(other)) {
      for (const mine of boxY) {
        const delta = target - mine
        if (Math.abs(delta) > threshold) continue
        if (!bestY || Math.abs(delta) < Math.abs(bestY.delta)) {
          bestY = { delta, position: target, other }
        }
      }
    }
  }

  const guides: Guide[] = []

  if (bestX) {
    // The guide spans from the topmost to the bottommost of the two boxes, so
    // it visibly connects what it is claiming are aligned.
    guides.push({
      axis: 'x',
      position: bestX.position,
      from: Math.min(box.y, bestX.other.y),
      to: Math.max(box.y + box.height, bestX.other.y + bestX.other.height),
    })
  }

  if (bestY) {
    guides.push({
      axis: 'y',
      position: bestY.position,
      from: Math.min(box.x, bestY.other.x),
      to: Math.max(box.x + box.width, bestY.other.x + bestY.other.width),
    })
  }

  return { dx: bestX?.delta ?? 0, dy: bestY?.delta ?? 0, guides }
}
