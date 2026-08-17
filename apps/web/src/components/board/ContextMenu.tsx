import { useCallback, useEffect, useRef, useState } from 'react'
import { boardStore, useBoardStore } from '../../stores/boardStore.js'
import {
  bringToFront,
  copySelection,
  duplicateSelection,
  pasteAt,
  sendToBack,
} from '../../features/canvas/interaction/handlers/clipboardActions.js'
import { probe, toCanvas } from '../../features/canvas/interaction/handlers/select.js'

/**
 * Right-click menu — FR-CANVAS-019 [P1], FLOWS §14.2.
 *
 * Two variants, exactly as specified:
 *   on an object — Duplicate, Copy, Bring to front, Send to back, Delete
 *   on empty canvas — Paste, Select all, Zoom to fit
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
  const ref = useRef<HTMLDivElement>(null)
  const selectionCount = useBoardStore(s => s.selection.length)

  const close = useCallback(() => {
    setMenu(null)
    container?.focus()
  }, [container])

  // Open on contextmenu over the canvas.
  useEffect(() => {
    if (!container) return

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault()
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
    if (menu) ref.current?.focus()
  }, [menu])

  if (!menu) return null

  const items: MenuItem[] = menu.onObject
    ? [
        { label: 'Duplicate', shortcut: '⌘D', onSelect: duplicateSelection },
        { label: 'Copy', shortcut: '⌘C', onSelect: copySelection },
        { label: 'Bring to front', onSelect: bringToFront },
        { label: 'Send to back', onSelect: sendToBack },
        {
          label: 'Delete',
          shortcut: '⌫',
          danger: true,
          onSelect: () =>
            boardStore.getState().deleteObjects(boardStore.getState().selection),
        },
      ]
    : [
        {
          label: 'Paste',
          shortcut: '⌘V',
          onSelect: () => void pasteAt(menu.canvasX, menu.canvasY),
        },
        {
          label: 'Select all',
          shortcut: '⌘A',
          onSelect: () => boardStore.getState().selectAll(),
        },
        {
          label: 'Zoom to fit',
          shortcut: '⌘1',
          onSelect: () => {
            const { width, height } = getSize()
            boardStore.getState().zoomToFit(width, height)
          },
        },
      ]

  const run = (item: MenuItem) => {
    item.onSelect()
    close()
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Board actions"
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
          disabled={item.label === 'Delete' && selectionCount === 0}
          onClick={() => run(item)}
          onPointerEnter={() => setActiveIndex(i)}
          className={
            'flex w-full cursor-pointer items-center justify-between gap-6 rounded-sm px-2 py-1.5 ' +
            'text-left text-xs transition-colors duration-fast ease-standard ' +
            'disabled:cursor-not-allowed disabled:opacity-40 ' +
            (item.danger ? 'text-danger ' : 'text-primary ') +
            (i === activeIndex ? (item.danger ? 'bg-danger/10' : 'bg-subtle') : '')
          }
        >
          {item.label}
          {item.shortcut && <kbd className="font-sans text-muted">{item.shortcut}</kbd>}
        </button>
      ))}
    </div>
  )
}
