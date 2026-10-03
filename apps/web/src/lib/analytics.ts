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

export type AnalyticsEvent =
  | 'board_opened'
  | 'board_joined_as_guest'
  | 'share_link_created'
  | 'share_link_copied'
  | 'export_completed'

type Props = Record<string, string | number | boolean>

const recorded: Array<{ event: AnalyticsEvent; props: Props; at: number }> = []

export function track(event: AnalyticsEvent, props: Props = {}): void {
  if (!import.meta.env.DEV) return
  recorded.push({ event, props, at: Date.now() })
  if (recorded.length > 200) recorded.shift()
}

/** Development and tests only. */
export const recordedEvents = () => [...recorded]
