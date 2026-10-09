import { Component, type ErrorInfo, type ReactNode } from 'react'
import { actions, errors, states } from '../../lib/strings.js'
import { reportClientError } from '../../lib/errorReporting.js'
import { Button } from '../ui/Button.js'

/**
 * S-21 — the error boundary, FLOWS §12.4.
 *
 * Two of them, deliberately:
 *
 *   variant="app"     wraps everything; a crash anywhere is a full screen
 *   variant="canvas"  wraps ONLY the canvas subtree, so a renderer or
 *                     interaction crash leaves the header, the connection
 *                     state and the way back to the dashboard working
 *
 * The full error goes to the server under a fresh correlation id; the user
 * sees only "Ref: 8f3a2b91" (PRD §8.1). No animation: this screen appears
 * because something already went wrong.
 *
 * A class, because only a class can be an error boundary in React 18.
 */

interface Props {
  variant: 'app' | 'canvas'
  children: ReactNode
}

interface State {
  correlationId: string | null
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { correlationId: null }

  static getDerivedStateFromError(): Partial<State> {
    // The id is assigned in componentDidCatch, where the report is sent;
    // a placeholder here makes the fallback render on this pass.
    return { correlationId: '' }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const correlationId = reportClientError({
      source: this.props.variant === 'canvas' ? 'canvas-boundary' : 'boundary',
      error,
      componentStack: info.componentStack ?? null,
    })
    this.setState({ correlationId })
  }

  override render(): ReactNode {
    const { correlationId } = this.state
    if (correlationId === null) return this.props.children

    const canvas = this.props.variant === 'canvas'
    return (
      <div
        role="alert"
        data-testid={canvas ? 'canvas-error-boundary' : 'error-boundary'}
        className={`flex w-full flex-col items-center justify-center gap-3 px-6 text-center ${
          canvas ? 'absolute inset-0 bg-canvas' : 'min-h-[100dvh] bg-app'
        }`}
      >
        <h1 className="text-lg font-semibold text-primary">
          {states.errorBoundary.headline}
        </h1>
        <p className="max-w-sm text-sm text-muted">{states.errorBoundary.body}</p>
        <div className="mt-2 flex gap-2">
          <Button onClick={() => window.location.reload()} data-testid="error-reload">
            {actions.reloadPage}
          </Button>
          {/* A plain link, not the router: the router itself may be what broke. */}
          <a href="/dashboard">
            <Button variant="secondary">{actions.backToDashboard}</Button>
          </a>
        </div>
        {correlationId && (
          <p className="mt-2 font-mono text-xs text-muted" data-testid="error-ref">
            {errors.genericServerErrorRef(correlationId)}
          </p>
        )}
      </div>
    )
  }
}
