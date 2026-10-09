import { lazy, Suspense, useEffect, useState } from 'react'
import { useLocation } from 'react-router'
import { openShortcuts, useShortcutsStore } from './board/shortcutsStore.js'

/*
 * Lazy: the modal and its table are needed only after someone presses `?`,
 * so they stay out of the initial chunk every visitor to /login downloads.
 */
const ShortcutsModal = lazy(() =>
  import('./board/ShortcutsModal.js').then(m => ({ default: m.ShortcutsModal })),
)

/** The board owns `?` itself — useKeyboard, with its own modal. */
export const isBoardPath = (pathname: string): boolean =>
  pathname === '/demo' || pathname.startsWith('/board/')

/**
 * R-A11Y-009: a shortcut never fires from a text field. A copy of the board's
 * check rather than an import of it — that module is the canvas interaction
 * layer, and importing it here would pull the canvas into every route.
 */
function isTextEntry(target: EventTarget | null): boolean {
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

/**
 * S-15 everywhere else — D-33.
 *
 * PRD §6 places the shortcuts modal on "any" route and Appendix A gives `?`
 * the context "Global". The board route already handles `?` through its
 * keyboard layer, so this listens only off the board, and stands down while a
 * text field or another modal has focus (FLOWS §13.3).
 */
export function GlobalShortcuts() {
  const { pathname } = useLocation()
  const onBoard = isBoardPath(pathname)
  const open = useShortcutsStore(s => s.open)
  // Mount the modal only once it has been asked for, then keep it, so its
  // close transition can run.
  const [wanted, setWanted] = useState(false)
  useEffect(() => {
    if (open) setWanted(true)
  }, [open])

  useEffect(() => {
    if (onBoard) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '?' || e.metaKey || e.ctrlKey || e.altKey) return
      if (isTextEntry(e.target)) return
      if (document.querySelector('[aria-modal="true"]')) return
      e.preventDefault()
      openShortcuts()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onBoard])

  if (onBoard || !wanted) return null
  return (
    <Suspense fallback={null}>
      <ShortcutsModal />
    </Suspense>
  )
}
