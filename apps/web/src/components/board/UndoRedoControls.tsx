import { useSyncExternalStore } from 'react'
import { ArrowArcLeft, ArrowArcRight } from '@phosphor-icons/react'
import { history } from '../../features/canvas/history/history.js'

/**
 * Undo / redo — FR-CANVAS-018, FLOWS §14.2.
 *
 * "~88 × 40 px, undo and redo buttons, disabled when the corresponding stack
 * is empty. Bottom-left, z-index: 20." The toast area sits above this at
 * z-index 40, which is why this is anchored to the bottom edge rather than
 * floated: the two must stack, not overlap.
 *
 * Zone: Board chrome. Skills ui-ux-pro-max + emil-design-eng, dials 4/2/6.
 * `gpt-taste`, `high-end-visual-design` and Framer Motion are all forbidden
 * here, and the board-chunk CI gate enforces the last one.
 *
 * MOTION (R-MOTION-001): undo is a top-band interaction — Persona A's stated
 * job is "undo mistakes instantly" — so nothing about the state change
 * animates. The buttons enable and disable instantly. The only motion is
 * scale(0.97) on press (R-MOTION-033) and a 120 ms hover colour, gated behind
 * a fine pointer (R-MOTION-061).
 *
 * R-ARCH-003: this subscribes to two BOOLEANS out of the history stack, not to
 * the stack itself and not to the object map. It re-renders when undo becomes
 * possible or impossible — a handful of times a minute.
 */

const BUTTON =
  'flex h-8 w-10 items-center justify-center rounded-sm text-primary ' +
  'transition-colors duration-fast ease-standard cursor-pointer ' +
  'hover:bg-subtle active:scale-[0.97] ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ' +
  // aria-disabled, not the disabled attribute — see the note below.
  'aria-disabled:cursor-not-allowed aria-disabled:opacity-40 ' +
  'aria-disabled:hover:bg-transparent aria-disabled:active:scale-100'

export function UndoRedoControls() {
  /*
   * The history stack is plain TypeScript with its own listener set, not a
   * Zustand store, because undo has no business re-rendering anything the
   * board store touches. useSyncExternalStore is the supported bridge, and
   * `canUndo`/`canRedo` return primitives so the snapshot is stable — a
   * getSnapshot returning a fresh object would loop forever.
   */
  const canUndo = useSyncExternalStore(
    history.subscribe,
    history.canUndo,
    history.canUndo,
  )
  const canRedo = useSyncExternalStore(
    history.subscribe,
    history.canRedo,
    history.canRedo,
  )

  return (
    <div
      className="pointer-events-auto absolute bottom-4 left-4 z-panel flex items-center gap-1 rounded-md border border-border bg-app p-1 shadow-panel"
      role="group"
      aria-label="Undo and redo"
      data-testid="undo-redo-controls"
    >
      <button
        type="button"
        className={BUTTON}
        /*
         * aria-disabled rather than the `disabled` attribute — ui-ux-pro-max,
         * R-A11Y-002. A disabled button is removed from the tab order, so a
         * keyboard user sweeping the bottom bar would never learn the control
         * exists until it happened to be live. It stays focusable and
         * announced; the click is guarded below instead.
         */
        aria-disabled={!canUndo}
        aria-keyshortcuts="Control+Z Meta+Z"
        aria-label="Undo"
        data-testid="undo-button"
        onClick={() => {
          if (canUndo) history.undo()
        }}
      >
        <ArrowArcLeft size={16} weight="light" aria-hidden="true" />
      </button>

      <button
        type="button"
        className={BUTTON}
        aria-disabled={!canRedo}
        aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z"
        aria-label="Redo"
        data-testid="redo-button"
        onClick={() => {
          if (canRedo) history.redo()
        }}
      >
        <ArrowArcRight size={16} weight="light" aria-hidden="true" />
      </button>
    </div>
  )
}
