import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'

/**
 * Dropdown — the board card's `⋮` menu and the dashboard's sort control.
 * FLOWS §6.2, §6.4.
 *
 * A real menu, not a styled `<div>` list. `role="menu"` with `role="menuitem"`
 * children gives arrow-key navigation, Home/End, type-ahead-free Escape, and
 * the announcement a screen reader needs; reimplementing that badly is the
 * usual cost of a hand-rolled dropdown.
 *
 * MOTION: 150 ms, opacity + `scale(0.95)` → 1, **origin at the trigger**. A
 * menu that grows from its own centre reads as unanchored; one that grows out
 * of the button that opened it reads as summoned by it (`R-MOTION-034`). Never
 * from `scale(0)` — nothing in the real world appears from nothing.
 *
 * Closing: Escape, a click anywhere outside, Tab out, or choosing an item.
 *
 * NOT on scroll, and that is a correction rather than an omission. The menu is
 * `position: absolute` inside its trigger's card, so page scroll carries it
 * along and it never detaches — there is nothing for a scroll-close to fix.
 * Worse, it actively broke the component: opening the menu moves focus to the
 * first item, the browser scrolls that item into view, the scroll handler fires
 * and closes the menu it was opening. The e2e suite caught it; the happy-dom
 * component test could not, because happy-dom's `focus()` does not scroll. A
 * portaled or fixed-position menu WOULD need scroll handling, and this one
 * would need it again the day it becomes one.
 */

export interface DropdownItem {
  label: string
  onSelect: () => void
  /** Renders in --color-danger. For destructive actions only. */
  danger?: boolean
  disabled?: boolean
  testId?: string
}

export interface DropdownProps {
  /** The trigger. Receives the aria wiring; must render a real button. */
  trigger: (props: {
    'aria-haspopup': 'menu'
    'aria-expanded': boolean
    'aria-controls': string
    onClick: (event: React.MouseEvent) => void
    ref: (node: HTMLButtonElement | null) => void
  }) => ReactNode
  items: DropdownItem[]
  /** Which corner the menu hangs from. Cards want 'right'. */
  align?: 'left' | 'right'
  label: string
}

export function Dropdown({ trigger, items, align = 'right', label }: DropdownProps) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const enabled = items.filter(item => !item.disabled)

  const close = useCallback(
    (returnFocus = true) => {
      setOpen(false)
      if (returnFocus) triggerRef.current?.focus()
    },
    [],
  )

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      // No focus return here: the user clicked somewhere else on purpose, and
      // yanking the caret back to the trigger would fight them.
      close(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open, close])

  useEffect(() => {
    if (open) setActiveIndex(0)
  }, [open])

  // Move DOM focus with the active index, so the screen reader follows.
  useEffect(() => {
    if (!open) return
    const node = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')
    /*
     * `preventScroll`: the menu has just rendered flush against its trigger,
     * which the user is already looking at, so scrolling it into view can only
     * move the page out from under them.
     */
    node?.[activeIndex]?.focus({ preventScroll: true })
  }, [open, activeIndex])

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex(i => (i + 1) % Math.max(enabled.length, 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(i => (i - 1 + enabled.length) % Math.max(enabled.length, 1))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setActiveIndex(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setActiveIndex(Math.max(enabled.length - 1, 0))
    } else if (event.key === 'Tab') {
      // Tabbing out of a menu closes it. Leaving it open behind the newly
      // focused control is how you end up with two open menus.
      close(false)
    }
  }

  return (
    <div className="relative inline-flex">
      {trigger({
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': menuId,
        onClick: event => {
          event.stopPropagation()
          setOpen(value => !value)
        },
        ref: node => {
          triggerRef.current = node
        },
      })}

      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          data-popover
          data-testid="dropdown-menu"
          onKeyDown={onMenuKeyDown}
          // Origin at the trigger: the menu hangs below it, so it scales from
          // the top edge on whichever side it is aligned to.
          style={{ transformOrigin: align === 'right' ? 'top right' : 'top left' }}
          className={`absolute top-full z-40 mt-1 min-w-[11rem] rounded-md border border-border bg-app py-1 shadow-panel ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {enabled.map((item, index) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              tabIndex={index === activeIndex ? 0 : -1}
              data-testid={item.testId}
              onClick={event => {
                event.stopPropagation()
                close(false)
                item.onSelect()
              }}
              className={`flex w-full cursor-pointer items-center px-3 py-2 text-left text-sm outline-none transition-colors duration-fast hover:bg-subtle focus-visible:bg-subtle ${
                item.danger ? 'text-danger' : 'text-primary'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
