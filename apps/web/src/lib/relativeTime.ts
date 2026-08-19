/**
 * Relative time for board cards — FLOWS §6.2.
 *
 * `Intl.RelativeTimeFormat` rather than a hand-written ladder of if-statements
 * or a date library. It is built in, it is zero bytes of bundle, and it gets
 * the plurals and the locale right in languages we have not thought about yet.
 *
 * FLOWS also asks for the ABSOLUTE time in the `title` attribute, and that
 * pairing is the actual requirement: "2 days ago" is what you scan a grid
 * with, and "14 August 2026 at 09:12" is what you need the moment you care.
 */

const DIVISIONS: Array<{ amount: number; unit: Intl.RelativeTimeFormatUnit }> = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' },
]

export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return ''

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  let duration = (then.getTime() - now.getTime()) / 1000

  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return formatter.format(Math.round(duration), division.unit)
    }
    duration /= division.amount
  }
  return formatter.format(Math.round(duration), 'year')
}

/** The `title` companion — the exact moment, spelled out. */
export function absoluteTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })
}
