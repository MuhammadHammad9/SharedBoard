import { useCallback, useEffect, useRef, useState } from 'react'
import { boardStore, selectedObjects, useBoardStore } from '../../stores/boardStore.js'
import {
  bringForward,
  bringToFront,
  copySelection,
  duplicateSelection,
  pasteAt,
  sendBackward,
  sendToBack,
} from '../../features/canvas/interaction/handlers/clipboardActions.js'
import { probe, toCanvas } from '../../features/canvas/interaction/handlers/select.js'
import { applyAndEmit, deleteOps } from '../../features/canvas/history/apply.js'
import { LABELS } from '../../features/canvas/history/grouping.js'
import {
  changeSelectionColour,
  colourTargetFor,
} from '../../features/canvas/interaction/handlers/changeColour.js'
import { boardChrome } from '../../lib/strings.js'
import { ColorSwatch } from '../ui/ColorSwatch.js'

const menuCopy = boardChrome.contextMenu

/**
 * Right-click menu — FR-CANVAS-019 [P1], FLOWS §14.2.
 *
 * Two variants, exactly as specified:
 *   on an object — Duplicate, Copy, Bring to front, Send to back,
 *                  Change colour, Delete
 *   on empty canvas — Paste, Select all, Zoom to fit
 *
 * "Change colour" swaps the menu's items for the selection's palette in
 * place, anchored where it was — the sticky palette for notes, the pen
 * palette otherwise (D-25). It is not offered for a selection with no single
 * palette (an image, or notes mixed with other types).
 *
 * MOTION: `opacity` + `scale(0.95)` → `1` over 150 ms, with the transform
 * ORIGIN AT THE POINTER (R-MOTION-034). A menu that grows from its own centre
 * reads as unanchored; one that grows from the click feels summoned by it.
 * This is the one place in Phase 5 with a real entrance animation, and it
 * earns it — a context menu is an occasional interaction, not a top-band one.
 *
 * R-A11Y-001: focus moves into the menu on open, Escape closes and returns
 * focus, and Up/Down move between items.
 */

interface MenuItem {
  label: string
  shortcut?: string
  onSelect: () => void
  danger?: boolean
  /** The item opens a second view of this menu rather than finishing it. */
  keepOpen?: boolean
}

interface ContextMenuProps {
  container: HTMLElement | null
  /** Zoom-to-fit needs the viewport's pixel size. */
  getSize: () => { width: number; height: number }
}

interface MenuState {
  /** Position in the container's coordinate space. */
  x: number
  y: number
  /** Canvas-space position, for paste. */
  canvasX: number
  canvasY: number
  onObject: boolean
}

export function ContextMenu({ container, getSize }: ContextMenuProps) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [choosingColour, setChoosingColour] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const selectionCount = useBoardStore(s => s.selection.length)

  const close = useCallback(() => {
    setMenu(null)
    setChoosingColour(false)
    container?.focus()
  }, [container])

  // Open on contextmenu over the canvas.
  useEffect(() => {
    if (!container) return

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      // Every item in this menu edits the board; a viewer gets no menu.
      if (boardStore.getState().readOnly) return
      const rect = container.getBoundingClientRect()
      const localX = e.clientX - rect.left
      const localY = e.clientY - rect.top
      const c = toCanvas(localX, localY)
      const hit = probe(c.x, c.y)

      // Right-clicking an unselected object selects it first, so the menu's
      // actions have an unambiguous target. Right-clicking inside an existing
      // multi-selection leaves it alone.
      if (hit.kind === 'object' && !boardStore.getState().selection.includes(hit.id)) {
        boardStore.getState().setSelection([hit.id])
      }

      setActiveIndex(0)
      setChoosingColour(false)
      setMenu({
        x: localX,
        y: localY,
        canvasX: c.x,
        canvasY: c.y,
        onObject: hit.kind !== 'empty',
      })
    }

    container.addEventListener('contextmenu', onContextMenu)
    return () => container.removeEventListener('contextmenu', onContextMenu)
  }, [container])

  // Close on outside press, Escape, or scroll.
  useEffect(() => {
    if (!menu) return
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('wheel', close, { passive: true })
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('wheel', close)
    }
  }, [menu, close])

  useEffect(() => {
    if (!menu) return
    // The palette view puts focus on its first swatch; the item view on the
    // menu itself, which then moves an active index.
    const first = choosingColour
      ? ref.current?.querySelector<HTMLButtonElement>('button')
      : null
    ;(first ?? ref.current)?.focus()
  }, [menu, choosingColour])

  if (!menu) return null

  // Read on render, not subscribed: the menu exists for one decision and the
  // selection cannot change under it without closing it.
  const colourTarget = menu.onObject ? colourTargetFor(selectedObjects()) : null

  if (choosingColour && colourTarget) {
    return (
      <div
        ref={ref}
        role="group"
        aria-label={menuCopy.changeColour}
        tabIndex={-1}
        data-testid="context-menu"
        data-view="colour"
        className="absolute z-modal rounded-md border border-border bg-app p-2 shadow-panel outline-none"
        style={{ left: menu.x, top: menu.y }}
      >
        <p className="mb-2 text-xs font-medium text-muted">{menuCopy.changeColour}</p>
        <div
          className={`grid gap-2 ${colourTarget.palette.length === 8 ? 'grid-cols-4' : 'grid-cols-5'}`}
        >
          {colourTarget.palette.map(({ value, name }) => (
            <ColorSwatch
              key={value}
              color={value}
              {...(name ? { name } : {})}
              selected={colourTarget.current?.toLowerCase() === value.toLowerCase()}
              onSelect={next => {
                changeSelectionColour(next)
                close()
              }}
            />
          ))}
        </div>
      </div>
    )
  }

  const items: MenuItem[] = menu.onObject
    ? [
        { label: menuCopy.duplicate, shortcut: '⌘D', onSelect: duplicateSelection },
        { label: menuCopy.copy, shortcut: '⌘C', onSelect: copySelection },
        { label: menuCopy.bringToFront, onSelect: bringToFront, shortcut: '⌘]' },
        { label: menuCopy.bringForward, onSelect: bringForward, shortcut: ']' },
        { label: menuCopy.sendBackward, onSelect: sendBackward, shortcut: '[' },
        { label: menuCopy.sendToBack, onSelect: sendToBack, shortcut: '⌘[' },
        ...(colourTarget
          ? [
              {
                label: menuCopy.changeColour,
                keepOpen: true,
                onSelect: () => setChoosingColour(true),
              },
            ]
          : []),
        {
          label: menuCopy.delete,
          shortcut: '⌫',
          danger: true,
          onSelect: () =>
            applyAndEmit(deleteOps(boardStore.getState().selection), LABELS.delete),
        },
      ]
    : [
        {
          label: menuCopy.paste,
          shortcut: '⌘V',
          onSelect: () => void pasteAt(menu.canvasX, menu.canvasY),
        },
        {
          label: menuCopy.selectAll,
          shortcut: '⌘A',
          onSelect: () => boardStore.getState().selectAll(),
        },
        {
          label: menuCopy.zoomToFit,
          shortcut: '⌘1',
          onSelect: () => {
            const { width, height } = getSize()
            boardStore.getState().zoomToFit(width, height)
          },
        },
      ]

  const run = (item: MenuItem) => {
    item.onSelect()
    if (!item.keepOpen) close()
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={menuCopy.label}
      tabIndex={-1}
      data-testid="context-menu"
      data-crossfade-menu=""
      className="absolute z-modal min-w-[11rem] rounded-md border border-border bg-app p-1 shadow-panel outline-none"
      style={{
        left: menu.x,
        top: menu.y,
        // R-MOTION-034: the menu scales from the pointer, not its own centre.
        transformOrigin: 'top left',
      }}
      onKeyDown={e => {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setActiveIndex(i => (i + 1) % items.length)
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          setActiveIndex(i => (i - 1 + items.length) % items.length)
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          const item = items[activeIndex]
          if (item) run(item)
        }
      }}
    >
      {items.map((item, i) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          data-testid={`menu-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
          disabled={item.label === menuCopy.delete && selectionCount === 0}
          onClick={() => run(item)}
          onPointerEnter={() => setActiveIndex(i)}
          className={
            'flex w-full cursor-pointer items-center justify-between gap-6 rounded-sm px-2 py-1.5 ' +
            'text-left text-xs transition-colors duration-fast ease-standard ' +
            'disabled:cursor-not-allowed disabled:opacity-40 ' +
            // Danger text on a danger tint is under 4.5:1; the focused danger item
            // inverts instead.
            (i === activeIndex
              ? item.danger
                ? 'bg-danger text-white'
                : 'bg-subtle text-primary'
              : item.danger
                ? 'text-danger'
                : 'text-primary')
          }
        >
          {item.label}
          {item.shortcut && <kbd className="font-sans text-muted">{item.shortcut}</kbd>}
        </button>
      ))}
    </div>
  )
}
