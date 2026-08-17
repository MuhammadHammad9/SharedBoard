import { useCallback, useEffect, useRef } from 'react'
import { boardStore } from '../../../stores/boardStore.js'
import { canChangeTool } from './machine.js'
import { endPan } from './handlers/pan.js'
import { cancelDraw } from './handlers/draw.js'
import {
  cancelDrag,
  cancelResize,
  cancelRotate,
  nudgeSelection,
} from './handlers/transform.js'
import { cancelCreate } from './handlers/create.js'
import {
  copySelection,
  cutSelection,
  duplicateSelection,
  pasteAt,
} from './handlers/clipboardActions.js'

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
 * Implemented so far: V, H, P, Escape, Space, Cmd+0, Cmd+1, Cmd +/-. The
 * remaining tool keys (E R O L A N T) are bound by the phases that make those
 * tools do something — see ACTIVE_TOOLS.
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

    const onKeyDown = (e: KeyboardEvent) => {
      // R-A11Y-009: never steal keys from a text field.
      if (isTextEntryTarget(e.target)) return

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
        switch (store.interaction.type) {
          case 'DRAWING':
            cancelDraw(el)
            return
          case 'DRAGGING':
            cancelDrag(el)
            return
          case 'RESIZING':
            cancelResize(el)
            return
          case 'ROTATING':
            cancelRotate(el)
            return
          case 'CREATING':
            cancelCreate(el)
            return
          case 'EDITING_TEXT':
            // Handled by the overlay itself, which owns focus. Reaching here
            // means the overlay is gone but the state is not — unwind it.
            store.endTextEdit()
            return
          default:
            // FR-CANVAS-022: Escape deselects and returns to the Select tool.
            store.clearSelection()
            if (store.activeTool !== 'select') store.setActiveTool('select')
        }
        return
      }

      // Delete the selection — FR-CANVAS-014. Not yet undoable; HistoryManager
      // arrives in Phase 6 and hooks the store's deleteObjects.
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (store.selection.length === 0) return
        if (!canChangeTool(store.interaction.type)) return
        e.preventDefault()
        store.deleteObjects(store.selection)
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
            e.preventDefault()
            // "Paste places objects at the pointer position" — the last known
            // pointer position, since a keyboard event carries none.
            const at = optionsRef.current.getPointer?.() ?? { x: 0, y: 0 }
            void pasteAt(at.x, at.y)
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
      switch (e.key.toLowerCase()) {
        case 'v':
          store.setActiveTool('select')
          break
        case 'h':
          store.setActiveTool('hand')
          break
        case 'p':
          store.setActiveTool('pen')
          break
        case 'e':
          store.setActiveTool('eraser')
          break
        case 'r':
          store.setActiveTool('rect')
          break
        case 'o':
          store.setActiveTool('ellipse')
          break
        case 'l':
          store.setActiveTool('line')
          break
        case 'a':
          store.setActiveTool('arrow')
          break
        case 'n':
          store.setActiveTool('sticky')
          break
        case 't':
          store.setActiveTool('text')
          break
        default:
          break
      }
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

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    // R-STATE-007: every listener has a matching remove.
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // Stable identity: usePointer takes this in its effect deps, and a fresh
  // closure every render would tear down and re-add the pointer listeners
  // continuously.
  const spaceHeld = useCallback(() => spaceRef.current, [])

  return { spaceHeld }
}
