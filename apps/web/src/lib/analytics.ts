/**
 * Analytics — PRD §9. A seam, not a product (decision D-5).
 *
 * There is no analytics provider in the repository. Phase 12 needs four
 * events to exist at the right moments; this records them in development and
 * does nothing else. Phase 14 task 18 points the sink at a real service, and
 * none of the call sites move.
 *
 * Event names are the PRD §9 names exactly. Properties never carry personal
 * data — no names, no emails, and never a guest id (decision D-1).
 */

/**
 * PRD §9 — the fourteen events and their properties, exactly. Typed, so an
 * event cannot be sent without the properties the PRD lists for it.
 */
export interface AnalyticsEvents {
  account_created: { method: AuthMethod }
  logged_in: { method: AuthMethod }
  board_created: { template: 'blank' | 'duplicate'; from: 'dashboard' | 'empty_state' }
  board_opened: { board_id: string; role: string; object_count: number; load_ms: number }
  board_joined_as_guest: { board_id: string }
  object_created: { type: string; board_id: string }
  tool_selected: { tool: string; via: 'click' | 'shortcut' }
  share_link_created: { access_level: string }
  share_link_copied: Record<string, never>
  export_completed: { format: string; scope: string }
  socket_disconnected: { reason: string; session_duration_ms: number }
  socket_reconnected: { attempts: number; downtime_ms: number; outbox_size: number }
  op_rejected: { op_type: string; reason: string }
  client_error: { message: string; component: string; correlation_id: string }
}

export type AnalyticsEvent = keyof AnalyticsEvents
type AuthMethod = 'password' | 'google'

type Props = Record<string, string | number | boolean>

const recorded: Array<{ event: AnalyticsEvent; props: Props; at: number }> = []

export function track<E extends AnalyticsEvent>(
  event: E,
  ...[props]: AnalyticsEvents[E] extends Record<string, never> ? [] : [AnalyticsEvents[E]]
): void {
  if (!import.meta.env.DEV) return
  recorded.push({ event, props: (props ?? {}) as Props, at: Date.now() })
  if (recorded.length > 200) recorded.shift()
}

/** Development and tests only. */
export const recordedEvents = () => [...recorded]
