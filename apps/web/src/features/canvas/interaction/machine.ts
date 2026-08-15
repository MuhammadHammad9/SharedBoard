/**
 * The canvas interaction state machine — FLOWS §15.1.
 *
 * R-CANVAS-050 (Blocking): exactly one state is active at a time. Illegal
 * transitions are bugs, not edge cases.
 *
 * The FULL state union is declared here in Phase 2 even though only IDLE and
 * PANNING have handlers yet. Declaring it now means R-CANVAS-051 — entering
 * PANNING from DRAWING is forbidden — is structurally impossible from the
 * outset rather than retrofitted in Phase 4 once drawing exists.
 *
 *                             ┌──────┐
 *               ┌────────────►│ IDLE │◄───────────────┐
 *               │             └──────┘                │
 *               │        pointerdown │                │
 *               │      ┌─────────────┼──────────┐     │
 *        on empty+     │      on object    on handle  │
 *        select tool   │      +select tool      │     │
 *               ▼      │             ▼          ▼     │
 *         ┌──────────┐ │      ┌───────────┐ ┌────────────┐
 *         │MARQUEEING│ │      │ DRAGGING  │ │ RESIZING/  │
 *         └──────────┘ │      └───────────┘ │ ROTATING   │
 *               │      │             │      └────────────┘
 *       pointerup      │       pointerup          │ pointerup
 *               └──────┼─────────────┴────────────┘
 *                      │
 *         with a draw tool active
 *                      ▼
 *               ┌────────────┐
 *               │  DRAWING   │──pointerup──► commit ──► IDLE
 *               └────────────┘
 *                      │ Escape / pointercancel
 *                      └──► discard ──► IDLE
 */

import type { ObjectId } from '@coboard/shared'

export type InteractionState =
  | { type: 'IDLE' }
  | {
      type: 'PANNING'
      startX: number
      startY: number
      originX: number
      originY: number
      pointerId: number | null
      previous: InteractionType
    }
  | { type: 'MARQUEEING'; startX: number; startY: number; pointerId: number }
  | { type: 'DRAGGING'; pointerId: number; ids: ObjectId[] }
  | { type: 'RESIZING'; pointerId: number; handle: string }
  | { type: 'ROTATING'; pointerId: number }
  | { type: 'DRAWING'; pointerId: number; opId: string }
  | { type: 'EDITING_TEXT'; objectId: ObjectId }

export type InteractionType = InteractionState['type']

/** States that hold a captured pointer and must release it on exit (R-CANVAS-053). */
export const CAPTURING_STATES: readonly InteractionType[] = [
  'PANNING',
  'MARQUEEING',
  'DRAGGING',
  'RESIZING',
  'ROTATING',
  'DRAWING',
]

export const isCapturing = (t: InteractionType): boolean => CAPTURING_STATES.includes(t)

/**
 * States from which PANNING may be entered.
 *
 * R-CANVAS-051 (Blocking): DRAWING is deliberately absent. Holding Space
 * during a stroke does nothing — entering PANNING mid-stroke corrupts the
 * stroke state (anti-pattern A-22). EDITING_TEXT is absent for the same
 * reason: Space is a legitimate character there.
 */
export const PAN_ENTRY_STATES: readonly InteractionType[] = [
  'IDLE',
  'MARQUEEING',
  'DRAGGING',
  'RESIZING',
  'ROTATING',
]

export const canEnterPanning = (from: InteractionType): boolean =>
  PAN_ENTRY_STATES.includes(from)

/**
 * Whether a transition is legal. Everything returns to IDLE; entry into an
 * interaction is only allowed from IDLE, except PANNING which may suspend
 * certain states and restore them on release.
 */
export function canTransition(from: InteractionType, to: InteractionType): boolean {
  if (from === to) return false
  if (to === 'IDLE') return true
  if (to === 'PANNING') return canEnterPanning(from)
  // Any other interaction may only begin from rest.
  return from === 'IDLE'
}

/**
 * Tool changes are queued and applied on return to IDLE — R-CANVAS-055,
 * FLOWS E-08. Switching tools mid-drag would strand the interaction.
 */
export const canChangeTool = (current: InteractionType): boolean => current === 'IDLE'
