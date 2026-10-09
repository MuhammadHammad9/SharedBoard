import { Eye } from '@phosphor-icons/react'
import { guest } from '../../lib/strings.js'

/**
 * Viewer mode's toolbar — FR-SHARE-006.
 *
 * The toolbar is REPLACED, not disabled: a column of greyed-out tools invites
 * clicking to find out why, and a viewer has nothing to find out. A Phosphor
 * `Eye`, not an emoji (R-UI-012), with the words beside it so the meaning is
 * never carried by the glyph alone (R-A11Y-007).
 */
export function ViewOnlyBadge() {
  return (
    <div
      role="status"
      data-testid="view-only-badge"
      className="pointer-events-auto absolute left-4 top-1/2 z-panel flex -translate-y-1/2 items-center gap-2 rounded-md border border-border bg-app px-3 py-2 text-xs font-medium text-muted shadow-panel"
    >
      <Eye size={16} weight="light" aria-hidden="true" />
      <span>{guest.viewOnly}</span>
    </div>
  )
}
