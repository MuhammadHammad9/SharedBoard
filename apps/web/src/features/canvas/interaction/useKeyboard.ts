import { useCallback, useEffect, useRef } from 'react'
import { boardStore } from '../../../stores/boardStore.js'
import { canChangeTool } from './machine.js'
import { endPan } from './handlers/pan.js'

/**
 * Keyboard handling for the canvas. PRD Appendix A.
 *
 * Phase 2 implements the viewport and tool subset: V, H, Space, Cmd+0, Cmd+1,
 * Cmd +/-. The rest arrive with their tools.
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
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true
}

export interface KeyboardOptions {
  getSize: () => { width: number; height: number }
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

      if (mod) {
        const c = centre()
        switch (e.key) {
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

      // Tool shortcuts. R-CANVAS-055: ignored while an interaction is running.
      if (!canChangeTool(store.interaction.type)) return
      switch (e.key.toLowerCase()) {
        case 'v':
          store.setActiveTool('select')
          break
        case 'h':
          store.setActiveTool('hand')
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
