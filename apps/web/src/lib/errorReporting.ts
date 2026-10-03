import { track } from './analytics.js'

/**
 * Client error reporting — S-21 (FLOWS §12.4), PRD §9 `client_error`.
 *
 * The user is shown ONE thing: an 8-character correlation id ("Ref:
 * 8f3a2b91"). Everything else — message, stack, component stack, board id —
 * goes to `POST /api/client-errors`, logged under that id, so a support
 * request quoting it finds the full record (PRD §8.1: never show internal
 * identifiers or stack traces).
 *
 * Fire-and-forget with `keepalive`: reporting must never become a second
 * error in front of the user, and a report sent as the page reloads should
 * still arrive.
 */

export type ErrorSource = 'boundary' | 'canvas-boundary' | 'window' | 'promise'

export function newCorrelationId(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

const boardIdFromUrl = (): string | undefined => {
  const match = /\/board\/([0-9a-f-]{36})/i.exec(globalThis.location?.pathname ?? '')
  return match?.[1]
}

export interface ErrorReport {
  source: ErrorSource
  error: unknown
  componentStack?: string | null
  component?: string
  correlationId?: string
}

/** Sends the report; returns the correlation id to show the user. */
export function reportClientError(report: ErrorReport): string {
  const correlationId = report.correlationId ?? newCorrelationId()
  const error =
    report.error instanceof Error ? report.error : new Error(String(report.error))
  const component =
    report.component ?? firstComponent(report.componentStack ?? undefined) ?? undefined
  const boardId = boardIdFromUrl()

  track('client_error', {
    message: error.message.slice(0, 200),
    component: component ?? 'unknown',
    correlation_id: correlationId,
  })

  const body = {
    correlationId,
    message: (error.message || 'Unknown error').slice(0, 500),
    source: report.source,
    ...(component ? { component: component.slice(0, 200) } : {}),
    ...(error.stack ? { stack: error.stack.slice(0, 8_000) } : {}),
    ...(report.componentStack
      ? { componentStack: report.componentStack.slice(0, 8_000) }
      : {}),
    ...(boardId ? { boardId } : {}),
    url: (globalThis.location?.pathname ?? '').slice(0, 2_000),
  }
  try {
    void fetch('/api/client-errors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
      credentials: 'include',
    }).catch(() => undefined)
  } catch {
    // Nothing: the screen already shows the id.
  }
  return correlationId
}

/** "    at PropertiesPanel (…)" → "PropertiesPanel". */
function firstComponent(componentStack: string | undefined): string | null {
  const match = /^\s*at (\w+)/m.exec(componentStack ?? '')
  return match?.[1] ?? null
}

let installed = false

/**
 * Errors outside React's render — event handlers, timers, promises. They do
 * not show S-21 (the screen still works), but they are reported.
 */
export function installGlobalErrorReporting(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('error', event => {
    // Resource load errors (an <img> 404) carry no `error` and are not bugs.
    if (!event.error) return
    reportClientError({ source: 'window', error: event.error })
  })
  window.addEventListener('unhandledrejection', event => {
    reportClientError({ source: 'promise', error: event.reason })
  })
}
