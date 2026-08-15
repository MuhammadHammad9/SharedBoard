import { useBoardStore } from '../../stores/boardStore.js'
import { PenProperties } from './properties/PenProperties.js'
import { SelectionProperties } from './properties/SelectionProperties.js'

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
 * Phases 3 and 4 implement the pen, eraser and selection contexts. Shapes,
 * sticky, text and image arrive with their phases; each is a new branch in
 * `content` and nothing else changes.
 *
 * PRECEDENCE: a non-empty selection outranks the active tool. §14.4 keys most
 * rows on the tool but its last three on the selection, and a user who has
 * just selected something wants to edit it — the pen's colour swatches are not
 * what they reached for.
 *
 * MOTION: the context swap is an opacity crossfade only, 120 ms, no slide
 * (R-MOTION-001 — switching tools is top-band, so the panel must not perform).
 * Sliding 240 px of content sideways every time the user presses P would be a
 * decoration on an interaction that happens all day.
 */

export function PropertiesPanel() {
  // Narrow selectors — R-ARCH-003. The COUNT, never the objects themselves.
  const activeTool = useBoardStore(s => s.activeTool)
  const hasSelection = useBoardStore(s => s.selection.length > 0)

  const context = hasSelection ? 'selection' : activeTool

  const content = hasSelection ? (
    <SelectionProperties />
  ) : activeTool === 'pen' ? (
    <PenProperties />
  ) : activeTool === 'eraser' ? (
    // FLOWS §14.4: "Eraser — eraser size indicator only". The object eraser
    // has no size to configure (the pixel eraser that would is [P2] and out of
    // scope), so the panel states what the tool does instead of inventing a
    // control that changes nothing.
    <p className="text-xs text-muted" data-testid="eraser-properties">
      Drag across objects to delete them.
    </p>
  ) : null

  // FLOWS §14.4: hidden entirely when there is nothing to show.
  if (!content) return null

  return (
    <aside
      // `key` restarts the crossfade when the context changes, so switching
      // from one tool's panel to another's fades rather than snapping.
      key={context}
      // The crossfade itself is in index.css — @starting-style, so it is a
      // transition rather than a keyframe and a fast P→V→P sweep retargets
      // instead of restarting.
      data-crossfade=""
      className="pointer-events-auto absolute right-4 top-1/2 z-panel w-60 rounded-md border border-border bg-app p-3 shadow-panel"
      aria-label="Properties"
      data-testid="properties-panel"
      data-context={context}
    >
      {content}
    </aside>
  )
}
