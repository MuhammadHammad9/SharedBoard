import type { ObjectId } from '@coboard/shared'

/**
 * Grouping — TRD §8.4, R-UNDO-010.
 *
 * | Action                   | Entries                                        |
 * | ------------------------ | ---------------------------------------------- |
 * | One stroke               | 1                                              |
 * | Drag 10 objects          | 1, containing 10 ops                           |
 * | Delete a multi-selection | 1                                              |
 * | Typing in a sticky note  | 1 per burst — coalesce within 1 s on the same object |
 * | Resize                   | 1, pushed on pointerup, never on pointermove   |
 * | Paste 5 objects          | 1                                              |
 *
 * Five of the six rows need no machinery at all: they are a consequence of
 * every commit path calling `applyAndEmit` ONCE with the whole batch, which is
 * why the handlers were written to take arrays from Phase 4 onward. A drag of
 * ten objects is one entry because `endDrag` makes one call, not because
 * anything here merges it afterwards.
 *
 * Only the typing row needs real logic, and this file is that logic: a
 * coalesce key, and the window inside which two entries carrying the same key
 * fold into one.
 */

/** TRD §8.4: "coalesce updates that occur within 1 s of each other". */
export const COALESCE_WINDOW_MS = 1_000

/**
 * Entries sharing a key, pushed inside the window, merge into one.
 *
 * Absent means "never coalesce", which is the default for every action in the
 * table except typing. A stroke drawn a tenth of a second after the previous
 * stroke is still two strokes and still two undos.
 */
export type CoalesceKey = string

/**
 * Typing into one object. The id is in the key so that tabbing from one sticky
 * note to the next inside a second starts a fresh entry — the two notes are
 * two separate things the user typed, and one Ctrl+Z should not empty both.
 */
export const typingKey = (id: ObjectId): CoalesceKey => `typing:${id}`

/**
 * Holding an arrow key down.
 *
 * §8.4 does not have a row for the keyboard nudge — FR-CANVAS-011 arrived
 * after the table was written — so this is an extension rather than a
 * transcription. It follows the typing row because it has the typing row's
 * shape: key repeat fires ~30 updates a second, and without coalescence a
 * two-second press would need sixty Ctrl+Zs to undo. The key includes the
 * selection so that nudging a different object starts a new entry.
 */
export const nudgeKey = (ids: readonly ObjectId[]): CoalesceKey =>
  `nudge:${[...ids].sort().join(',')}`

/** Labels. Debug-only today; a history panel would surface them (TRD §8.1). */
export const LABELS = {
  draw: 'draw',
  create: 'create',
  paste: 'paste',
  duplicate: 'duplicate',
  delete: 'delete',
  erase: 'erase',
  cut: 'cut',
  move: 'move',
  resize: 'resize',
  rotate: 'rotate',
  nudge: 'nudge',
  typing: 'typing',
  style: 'style',
  reorder: 'reorder',
} as const

export type HistoryLabel = (typeof LABELS)[keyof typeof LABELS]
