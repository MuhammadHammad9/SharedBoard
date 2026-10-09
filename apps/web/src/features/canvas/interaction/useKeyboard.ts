import { useCallback, useEffect, useRef } from 'react'
import { boardStore, type Tool } from '../../../stores/boardStore.js'
import { track } from '../../../lib/analytics.js'
import { canChangeTool } from './machine.js'
import { endPan } from './handlers/pan.js'
import { nudgeSelection } from './handlers/transform.js'
import { cancelActiveGesture } from './cancelGesture.js'
import {
  bringForward,
  bringToFront,
  copySelection,
  cutSelection,
  duplicateSelection,
  pasteAt,
  sendBackward,
  sendToBack,
} from './handlers/clipboardActions.js'
import { applyAndEmit, deleteOps } from '../history/apply.js'
import { LABELS } from '../history/grouping.js'
import { history } from '../history/history.js'
import { openExport } from '../../export/exportStore.js'
import { isModalOpen } from '../../../components/ui/Modal.js'
import { openShortcuts } from '../../../components/board/shortcutsStore.js'

/** Tool shortcuts — PRD Appendix A. Lower-cased `KeyboardEvent.key`. */
const SHORTCUT_TOOLS: Record<string, Tool | undefined> = {
  v: 'select',
  h: 'hand',
  p: 'pen',
  e: 'eraser',
  r: 'rect',
  o: 'ellipse',
  l: 'line',
  a: 'arrow',
  n: 'sticky',
  t: 'text',
}

/** Arrow key → unit direction. FR-CANVAS-011. */
const ARROW_DELTAS: Record<string, { x: number; y: number } | undefined> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
}

/**
 * Keyboard handling for the canvas. PRD Appendix A.
 *
 * V H P E R O L A N T, Escape, Delete, arrows, Space, `[` / `]` (with Cmd
 * for to-front / to-back — FR-CANVAS-016), Cmd+A/C/X/V/D/Z, Cmd+Shift+Z,
 * Cmd+Shift+E, Cmd+0, Cmd+1, Cmd +/- and `?`. The image tool has no letter:
 * images arrive by drop, paste or the toolbar's picker.
 *
 * R-A11Y-009 (Blocking): EVERY shortcut is suppressed while a text input, the
 * on-canvas text overlay, or a modal has focus — except Escape and
 * Cmd/Ctrl+Enter.
 */

/** True when focus is somewhere that should swallow shortcuts. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName.toLowerCase()
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    el.isContentEditable === true
  )
}

export interface KeyboardOptions {
  getSize: () => { width: number; height: number }
  /** The canvas element, so a cancelled interaction can release its pointer. */
  getElement?: () => Element | null
  /**
   * Last known pointer position in CANVAS coordinates.
   *
   * FR-CANVAS-015 pastes "at the pointer position", but a keyboard event does
   * not carry one — so the pointer handler records it and this reads it back.
   */
  getPointer?: () => { x: number; y: number }
  /** Image files pasted from the system clipboard — FR-CANVAS-010. */
  onPasteImages?: (files: File[]) => void
}

export function useKeyboard(options: KeyboardOptions): { spaceHeld: () => boolean } {
  const spaceRef = useRef(false)
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    const centre = () => {
      const { width, height } = optionsRef.current.getSize()
      return { x: width / 2, y: height / 2 }
    }

    /** The latest Cmd+V, so an image paste can stand the object paste down. */
    let pasteIntent: { claimed: boolean } | null = null

    const onKeyDown = (e: KeyboardEvent) => {
      // R-A11Y-009: never steal keys from a text field.
      if (isTextEntryTarget(e.target)) return
      // …nor from a modal (P14-1). The modal answers its own Escape, so
      // nothing here does — not even the canvas's deselect.
      if (isModalOpen()) return

      // S-15 — `?` opens the shortcuts reference (PRD Appendix A, FR-SET-003).
      // Shift+/ on most layouts; matched on the character, not the key code.
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        openShortcuts()
        return
      }

      const store = boardStore.getState()
      const mod = e.metaKey || e.ctrlKey

      /*
       * Escape — FLOWS E-09. Handled BEFORE the canChangeTool gate, because
       * its entire purpose is to escape an in-progress interaction. Gating it
       * behind IDLE would make the one key that unwinds a stroke work only
       * when there is no stroke to unwind.
       */
      if (e.key === 'Escape') {
        e.preventDefault()
        const el = optionsRef.current.getElement?.() ?? null
        if (store.interaction.type === 'EDITING_TEXT') {
          // Handled by the overlay itself, which owns focus. Reaching here
          // means the overlay is gone but the state is not — unwind it.
          store.endTextEdit()
          return
        }
        // Mid-gesture, Escape cancels THAT gesture and nothing else — the
        // tool never changes under a live pointer (R-CANVAS-055).
        if (cancelActiveGesture(el)) return
        if (store.interaction.type !== 'IDLE') return
        // FR-CANVAS-022: Escape deselects and returns to the Select tool.
        store.clearSelection()
        if (store.activeTool !== 'select') store.setActiveTool('select')
        return
      }

      /*
       * Viewer mode — FR-SHARE-006. Only keys that change nothing survive:
       * Space to pan, and Cmd/Ctrl with 0, 1, +, − (zoom), C (copy) or A
       * (select all, which copy needs). Everything else is ignored here, so
       * no shortcut can start an edit the server would refuse.
       */
      /*
       * Cmd+Shift+E — S-14 export (FLOWS §11). Read-only, so viewers too.
       * Before the viewer gate and before the mod switch, where a bare `e`
       * would be read as the eraser.
       */
      if (mod && e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        openExport()
        return
      }

      if (store.readOnly) {
        const viewSafe =
          e.code === 'Space' ||
          (mod && ['0', '1', '=', '+', '-', '_', 'c', 'a'].includes(e.key.toLowerCase()))
        if (!viewSafe) return
      }

      // Delete the selection — FR-CANVAS-014, one entry for the whole
      // selection however large it is (R-UNDO-004).
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (store.selection.length === 0) return
        if (!canChangeTool(store.interaction.type)) return
        e.preventDefault()
        applyAndEmit(deleteOps(store.selection), LABELS.delete)
        return
      }

      /*
       * Z-order — FR-CANVAS-016, PRD Appendix A.
       *
       *   ]        bring forward        Cmd/Ctrl+]   bring to front
       *   [        send backward        Cmd/Ctrl+[   send to back
       *
       * Checked before the arrow nudge because both are plain single keys and
       * the first match wins.
       */
      if (e.key === ']' || e.key === '[') {
        if (store.selection.length === 0) return
        if (!canChangeTool(store.interaction.type)) return
        e.preventDefault()
        const toExtreme = e.metaKey || e.ctrlKey
        if (e.key === ']') {
          if (toExtreme) bringToFront()
          else bringForward()
        } else if (toExtreme) sendToBack()
        else sendBackward()
        return
      }

      // Arrow-key nudge — FR-CANVAS-011. 1 canvas px, 10 with Shift.
      // Canvas units, not screen: nudging must move the object the same
      // distance in the document regardless of zoom, or the same keypress
      // means different things at 10% and 500%.
      const nudge = ARROW_DELTAS[e.key]
      if (nudge) {
        if (store.selection.length === 0) return
        if (!canChangeTool(store.interaction.type)) return
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        nudgeSelection(nudge.x * step, nudge.y * step)
        return
      }

      if (mod) {
        const c = centre()
        switch (e.key.toLowerCase()) {
          /*
           * Undo and redo — FR-CANVAS-018, PRD Appendix A.
           *
           * Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z. `e.key` for Shift+Z is 'Z', so
           * the lowercase switch catches both and the shiftKey flag picks the
           * direction.
           *
           * R-A11Y-009 is already satisfied by the isTextEntryTarget guard at
           * the top of this handler: while the on-canvas text overlay has
           * focus, Cmd+Z belongs to the textarea's own undo, and stealing it
           * would make typing in a sticky note feel broken.
           *
           * Gated on canChangeTool for the same reason every other shortcut
           * is: undoing halfway through a drag would apply an inverse against
           * a document the gesture is still rewriting.
           */
          case 'z':
            if (!canChangeTool(store.interaction.type)) return
            e.preventDefault()
            if (e.shiftKey) history.redo()
            else history.undo()
            return
          case 'a':
            // FR-CANVAS-022: ALL objects, not just the visible ones.
            e.preventDefault()
            store.selectAll()
            return
          // Clipboard — FR-CANVAS-015.
          case 'c':
            if (store.selection.length === 0) return
            e.preventDefault()
            copySelection()
            return
          case 'x':
            if (store.selection.length === 0) return
            e.preventDefault()
            cutSelection()
            return
          case 'v': {
            /*
             * NOT preventDefault: the browser must still fire its own `paste`
             * event, because that is the only place an image copied from the
             * OS arrives (clipboardData.files). If it carries one, the paste
             * listener below claims this intent and the object paste stands
             * down — the read below is async, so the claim always lands first.
             */
            const intent = { claimed: false }
            pasteIntent = intent
            // "Paste places objects at the pointer position" — the last known
            // pointer position, since a keyboard event carries none.
            const at = optionsRef.current.getPointer?.() ?? { x: 0, y: 0 }
            void pasteAt(at.x, at.y, () => intent.claimed)
            return
          }
          case 'd':
            if (store.selection.length === 0) return
            e.preventDefault()
            duplicateSelection()
            return
          case '0':
            e.preventDefault()
            store.resetZoom(c.x, c.y)
            return
          case '1': {
            e.preventDefault()
            const { width, height } = optionsRef.current.getSize()
            store.zoomToFit(width, height)
            return
          }
          case '=':
          case '+':
            e.preventDefault()
            store.zoomAt(c.x, c.y, 1.2)
            return
          case '-':
          case '_':
            e.preventDefault()
            store.zoomAt(c.x, c.y, 1 / 1.2)
            return
          default:
            return
        }
      }

      if (e.code === 'Space' && !spaceRef.current) {
        // Held Space arms panning. R-CANVAS-051 keeps it inert during DRAWING.
        spaceRef.current = true
        e.preventDefault()
        return
      }

      // Tool shortcuts. R-CANVAS-055 / FLOWS E-08: a tool change during an
      // interaction is ignored, not queued into a half-finished stroke.
      if (!canChangeTool(store.interaction.type)) return
      const tool = SHORTCUT_TOOLS[e.key.toLowerCase()]
      if (!tool) return
      // PRD §9 tool_selected — only when the tool really changes. Pressing P
      // while already on Pen is not a selection. The implicit returns to
      // Select (Escape above, and after creating an object) are not tracked:
      // the user did not choose a tool, the machine reset one.
      if (store.activeTool !== tool) track('tool_selected', { tool, via: 'shortcut' })
      store.setActiveTool(tool)
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      spaceRef.current = false
      // Releasing Space ends a Space-driven pan. R-CANVAS-053.
      if (boardStore.getState().interaction.type === 'PANNING') endPan(null)
    }

    // Losing the window mid-pan must not strand the machine.
    const onBlur = () => {
      spaceRef.current = false
      if (boardStore.getState().interaction.type === 'PANNING') endPan(null)
    }

    /*
     * The browser's own paste — FR-CANVAS-010. Fires after the Cmd+V keydown
     * above (and for Edit → Paste). Only image FILES are handled here; text
     * and CoBoard objects stay with `pasteAt`.
     */
    const onPaste = (e: ClipboardEvent) => {
      if (isTextEntryTarget(e.target) || isModalOpen()) return
      if (boardStore.getState().readOnly) return
      const images = Array.from(e.clipboardData?.files ?? []).filter(f =>
        f.type.startsWith('image/'),
      )
      if (images.length === 0) return
      e.preventDefault()
      if (pasteIntent) pasteIntent.claimed = true
      optionsRef.current.onPasteImages?.(images)
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    window.addEventListener('paste', onPaste)
    // R-STATE-007: every listener has a matching remove.
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('paste', onPaste)
    }
  }, [])

  // Stable identity: usePointer takes this in its effect deps, and a fresh
  // closure every render would tear down and re-add the pointer listeners
  // continuously.
  const spaceHeld = useCallback(() => spaceRef.current, [])

  return { spaceHeld }
}
