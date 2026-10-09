import { useEffect, useLayoutEffect, useRef } from 'react'
import { boardStore, useBoardStore } from '../../stores/boardStore.js'
import { keyboardPanDelta, visibleBand } from './keyboardAvoidance.js'

/** Below this much lost height, the visual viewport is not a keyboard. */
const KEYBOARD_MIN_HEIGHT_PX = 120
import { boardChrome } from '../../lib/strings.js'
import {
  commitTextEdit,
  flushPendingText,
  updateEditingText,
} from './interaction/handlers/textEdit.js'
import {
  LINE_HEIGHT_RATIO,
  STICKY_FONT_MAX,
  STICKY_PADDING,
  FONT_STACK,
} from './renderer/textMetrics.js'

/**
 * The DOM text editor — layer 4, TRD D-6, FLOWS §8.2.2.
 *
 * A real `<textarea>` overlaid on the canvas, transparent, positioned and
 * scaled to match the object's screen rectangle. The canvas draws the text
 * underneath; this element only holds the caret and the keystrokes.
 *
 * THE DECISION, and it is not up for reconsideration (anti-pattern A-23):
 *
 * > IME input, spellcheck, mobile keyboards, accessibility, text selection,
 * > and copy/paste all come free. Implementing a caret on canvas is weeks of
 * > work and will be worse. Do not do it.
 *
 * That is why the text is `transparent` with a visible `caretColor`: the user
 * sees the CANVAS's rendering of their text, and the textarea's own glyphs are
 * never painted. Two visible copies, one lagging the other by a frame, is the
 * artefact this avoids.
 *
 * The three exits — Escape, click outside, Tab — all route to `commitTextEdit`
 * (FLOWS §8.2.2 step 4).
 */

interface TextOverlayProps {
  /** The canvas surface, used to convert canvas coordinates to element space. */
  container: HTMLElement | null
}

export function TextOverlay({ container }: TextOverlayProps) {
  const ref = useRef<HTMLTextAreaElement>(null)

  // Narrow selectors — R-ARCH-003. The id and the viewport, never the Map.
  const editingId = useBoardStore(s => s.editingTextId)
  const viewport = useBoardStore(s => s.viewport)
  const objectsVersion = useBoardStore(s => s.objectsVersion)

  const object = useBoardStore(s =>
    s.editingTextId ? s.objects.get(s.editingTextId) : undefined,
  )

  /*
   * Focus on mount, and select nothing — the caret goes to the end.
   *
   * useLayoutEffect, not useEffect: FR-CANVAS-008 requires "click and type
   * without a second action", and a focus that lands a frame late drops the
   * user's first keystroke onto the document instead of into the note.
   */
  useLayoutEffect(() => {
    if (!editingId) return
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
  }, [editingId])

  // The debounced text op never outlives the editor: switching objects or
  // unmounting the overlay sends whatever was typed since the last pause.
  useEffect(() => () => flushPendingText(), [editingId])

  /*
   * FLOWS §14.5: "Text editing scrolls the canvas so the edited object sits
   * above the keyboard." The on-screen keyboard shrinks the VISUAL viewport,
   * so it is the visualViewport's resize that says the keyboard arrived. The
   * response is a pan of the canvas — a viewport change, never a stored
   * coordinate (R-COORD-002).
   *
   * Only while a keyboard is plausibly open (the visual viewport is well
   * short of the layout viewport): on a desktop, editing a note near the
   * window edge must not shove the board around.
   */
  useEffect(() => {
    if (!editingId) return
    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    if (!vv) return
    const avoid = () => {
      const band = visibleBand()
      const el = ref.current
      if (!band || !el) return
      if (window.innerHeight - vv.height < KEYBOARD_MIN_HEIGHT_PX) return
      const rect = el.getBoundingClientRect()
      const dy = keyboardPanDelta(rect.top, rect.bottom, band.top, band.bottom)
      if (dy !== 0) boardStore.getState().panBy(0, dy)
    }
    avoid()
    vv.addEventListener('resize', avoid)
    return () => vv.removeEventListener('resize', avoid)
  }, [editingId])

  /*
   * Click-outside commits — FLOWS §8.2.2 step 4.
   *
   * `pointerdown` rather than `click`, so the commit happens before the canvas
   * decides what that press selected. On `click` the press would already have
   * started a marquee or a drag on the object underneath.
   */
  useEffect(() => {
    if (!editingId) return
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) commitTextEdit()
    }
    // Capture phase, for the same reason: ahead of the canvas's own handler.
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [editingId])

  if (!editingId || !object || (object.type !== 'sticky' && object.type !== 'text'))
    return null

  // Canvas → element space. The container is the positioning parent, so this
  // is the same transform the renderer applies, done once for one element.
  const left = object.x * viewport.zoom + viewport.x
  const top = object.y * viewport.zoom + viewport.y
  const width = object.width * viewport.zoom
  const height = object.height * viewport.zoom

  const isSticky = object.type === 'sticky'
  // The canvas may be auto-shrinking a sticky's text; the textarea cannot know
  // the fitted size without measuring, so it uses the maximum and stays
  // transparent. Only the caret and selection are visible, and both track the
  // line box closely enough at this scale.
  const fontSize = isSticky
    ? (object.fontSize === 'auto' ? STICKY_FONT_MAX : object.fontSize) * viewport.zoom
    : object.fontSize * viewport.zoom
  const padding = isSticky ? STICKY_PADDING * viewport.zoom : 0

  return (
    <textarea
      ref={ref}
      value={object.text}
      onChange={e => updateEditingText(e.target.value)}
      // Focus leaving (another window, a toolbar control) sends the pending
      // text now rather than after the debounce.
      onBlur={flushPendingText}
      onKeyDown={e => {
        // Escape and Tab both commit. Neither may bubble: Escape would reach
        // the canvas's deselect handler, Tab would move focus into the toolbar.
        if (e.key === 'Escape' || e.key === 'Tab') {
          e.preventDefault()
          e.stopPropagation()
          commitTextEdit()
          container?.focus()
        }
        // Every other key stays here. R-A11Y-009 exempts a focused text field
        // from the canvas shortcuts, and this is that field.
        e.stopPropagation()
      }}
      // R-A11Y-002: the element is visually invisible, so its accessible name
      // has to come from somewhere.
      aria-label={isSticky ? boardChrome.stickyTextLabel : boardChrome.textLabel}
      data-testid="text-overlay-input"
      spellCheck
      className="absolute resize-none overflow-hidden border-0 bg-transparent p-0 outline-none"
      style={{
        left,
        top,
        width,
        height,
        // z-index 4 — above all three canvas layers, below the board chrome.
        zIndex: 4,
        padding,
        fontFamily: FONT_STACK,
        fontSize,
        lineHeight: LINE_HEIGHT_RATIO,
        fontWeight: !isSticky && object.type === 'text' && object.bold ? 600 : 400,
        fontStyle:
          !isSticky && object.type === 'text' && object.italic ? 'italic' : 'normal',
        textAlign: object.textAlign,
        // The canvas owns the visible glyphs. This element contributes the
        // caret and the selection highlight, nothing else.
        color: 'transparent',
        caretColor: object.type === 'text' ? object.color : '#18181B',
      }}
      // Referenced so the overlay re-renders when the object's text changes
      // through any other path.
      data-version={objectsVersion}
    />
  )
}
