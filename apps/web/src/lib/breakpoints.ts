import { useEffect, useState } from 'react'

/**
 * PRD §7.7 breakpoints, by name.
 *
 *   desktop  ≥ 1280  left toolbar, right properties panel
 *   laptop   1024–1279  properties become a popover on selection
 *   tablet   768–1023  the toolbar becomes a bottom bar
 *   mobile   < 768  bottom bar of core tools + ⋯ sheet; properties as a
 *                   bottom sheet on selection (D-16); no marquee
 */
export type Breakpoint = 'desktop' | 'laptop' | 'tablet' | 'mobile'

export const breakpointFor = (width: number): Breakpoint =>
  width >= 1280 ? 'desktop' : width >= 1024 ? 'laptop' : width >= 768 ? 'tablet' : 'mobile'

/** For plain-TS callers (the pointer handlers): the layout right now. */
export const currentBreakpoint = (): Breakpoint =>
  breakpointFor(typeof window === 'undefined' ? 1280 : window.innerWidth)

const QUERIES = ['(min-width: 1280px)', '(min-width: 1024px)', '(min-width: 768px)']

/**
 * The current breakpoint, re-rendering ONLY when it changes — not on every
 * resize pixel. matchMedia fires on the threshold crossings alone.
 */
export function useBreakpoint(): Breakpoint {
  const [value, setValue] = useState(currentBreakpoint)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const lists = QUERIES.map(q => window.matchMedia(q))
    const update = () => setValue(currentBreakpoint())
    lists.forEach(l => l.addEventListener('change', update))
    update()
    return () => lists.forEach(l => l.removeEventListener('change', update))
  }, [])
  return value
}
