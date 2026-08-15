import { useBoardStore } from '../../stores/boardStore.js'
import { PenProperties } from './properties/PenProperties.js'

/**
 * Properties panel — FLOWS §14.2 and §14.4. 240 px, floating right, 16 px from
 * the edge, z-index: panel.
 *
 * Context-sensitive to the active tool or the current selection. §14.4's first
 * row is the one that shapes the component: "Select tool, nothing selected →
 * Panel hidden". Hidden means *not rendered*, not an empty 240 px box — a
 * permanent blank panel is 240 px of canvas the user paid for and got nothing
 * from.
 *
 * Phase 3 implements the pen context. Eraser, shapes, sticky, text, image and
 * the selection contexts arrive with their phases; each is a new branch in
 * `content` and nothing else changes.
 *
 * MOTION: the context swap is an opacity crossfade only, 120 ms, no slide
 * (R-MOTION-001 — switching tools is top-band, so the panel must not perform).
 * Sliding 240 px of content sideways every time the user presses P would be a
 * decoration on an interaction that happens all day.
 */

export function PropertiesPanel() {
  // Narrow selectors — R-ARCH-003.
  const activeTool = useBoardStore(s => s.activeTool)

  const content = activeTool === 'pen' ? <PenProperties /> : null

  // FLOWS §14.4: hidden entirely when there is nothing to show.
  if (!content) return null

  return (
    <aside
      // `key` restarts the crossfade when the context changes, so switching
      // from one tool's panel to another's fades rather than snapping.
      key={activeTool}
      // The crossfade itself is in index.css — @starting-style, so it is a
      // transition rather than a keyframe and a fast P→V→P sweep retargets
      // instead of restarting.
      data-crossfade=""
      className="pointer-events-auto absolute right-4 top-1/2 z-panel w-60 rounded-md border border-border bg-app p-3 shadow-panel"
      aria-label="Properties"
      data-testid="properties-panel"
      data-context={activeTool}
    >
      {content}
    </aside>
  )
}
