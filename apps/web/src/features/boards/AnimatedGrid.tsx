import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Children, type ReactNode } from 'react'

/**
 * The animated grid. Lazy-loaded by BoardGrid — never import this directly.
 *
 * MOTION, all from the Phase 8 table:
 *
 * - Entry: stagger, `opacity` + `translateY(8px)` → 0, 300 ms, 40 ms apart.
 * - Exit: `opacity` + collapse, 200 ms, so a trashed card leaves rather than
 *   vanishing and letting the grid snap shut.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  NO `layout` PROP, and that is a correction rather than an omission.     │
 * │                                                                          │
 * │  It makes surviving cards slide to their new positions when one is       │
 * │  removed, which looks lovely and turns the grid into a moving target for │
 * │  300 ms after every change. A `⋮` menu clicked during that window can    │
 * │  miss — the e2e suite caught it doing exactly that under load, and a     │
 * │  user with a trackpad is in the same position.                           │
 * │                                                                          │
 * │  It is also outside the Phase 8 motion table, which lists entry, hover,  │
 * │  delete and restore and nothing about neighbours moving. And it is the   │
 * │  same complaint as anti-pattern A-70, which already bans hover scale     │
 * │  because "a card that grows under the cursor shifts its neighbours and   │
 * │  the grid twitches" — sliding neighbours are that, with a longer         │
 * │  duration.                                                               │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * **The stagger caps at 12** (`R-MOTION-039`). Fifty cards at 40 ms is a
 * two-second wait before the last one appears, which is not delight, it is the
 * page being slow on purpose. Past the cap everything arrives together.
 *
 * `transform` strings, not the `x`/`y` shorthand — `R-SKILL-062`. The
 * shorthand props are not hardware-accelerated and run rAF on the main thread,
 * which drops frames exactly when the page is busy rendering a grid.
 *
 * `useReducedMotion` is mandatory (`R-A11Y-010`), and it removes the MOVEMENT
 * while keeping the fade: the opacity change still explains that something
 * arrived, which is the part that aids comprehension.
 */

const STAGGER_CAP = 12
const STAGGER_MS = 0.04

export default function AnimatedGrid({
  children,
  className,
}: {
  children: ReactNode
  className: string
}) {
  const reduced = useReducedMotion()

  return (
    <div className={className}>
      <AnimatePresence initial={false}>
        {Children.map(children, (child, index) => (
          <motion.div
            key={(child as { key?: string })?.key ?? index}
            initial={{
              opacity: 0,
              transform: reduced ? 'translateY(0px)' : 'translateY(8px)',
            }}
            animate={{ opacity: 1, transform: 'translateY(0px)' }}
            exit={{ opacity: 0, transform: 'scale(0.98)' }}
            transition={{
              duration: reduced ? 0.15 : 0.3,
              ease: [0.23, 1, 0.32, 1],
              delay: reduced ? 0 : Math.min(index, STAGGER_CAP) * STAGGER_MS,
            }}
          >
            {child}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
