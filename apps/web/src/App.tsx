import { PRESENCE_COLOURS, ZOOM_MAX, ZOOM_MIN, canvasPoint, screenToCanvas } from '@coboard/shared'
import { Palette } from '@phosphor-icons/react'

/**
 * Phase 1 placeholder.
 *
 * Its only job is to prove the wiring end to end: the shared package resolves,
 * PRD §15 tokens are live in Tailwind, Phosphor icons render (C-2), and the
 * branded coordinate types compile. Real routing arrives in Phase 2.
 */
export default function App() {
  // Proves the shared geometry helpers and branded types are usable here.
  const origin = screenToCanvas({ x: 0, y: 0 } as never, { x: 0, y: 0, zoom: 1 })
  const sample = canvasPoint(origin.x, origin.y)

  return (
    <main className="min-h-[100dvh] bg-subtle text-primary">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-12">
        <header className="flex items-center gap-3">
          <Palette size={28} weight="light" className="text-accent" aria-hidden="true" />
          <h1 className="text-2xl font-semibold tracking-tight">CoBoard</h1>
        </header>

        <p className="text-muted">
          Phase 1 foundation. Workspace, shared package, design tokens and CI gates are
          wired. The canvas arrives in Phase 2.
        </p>

        <section
          className="rounded-lg border border-border bg-app p-6 shadow-panel"
          aria-labelledby="tokens-heading"
        >
          <h2 id="tokens-heading" className="mb-4 text-sm font-medium">
            Design tokens — PRD §15
          </h2>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ['accent', 'bg-accent'],
                ['danger', 'bg-danger'],
                ['success', 'bg-success'],
                ['warning', 'bg-warning'],
                ['canvas', 'bg-canvas'],
                ['subtle', 'bg-subtle'],
              ] as const
            ).map(([name, cls]) => (
              <div key={name} className="flex flex-col items-center gap-1">
                <div className={`h-10 w-10 rounded-md border border-border ${cls}`} />
                <span className="text-[10px] text-muted">{name}</span>
              </div>
            ))}
          </div>

          <h2 className="mb-2 mt-6 text-sm font-medium">Presence palette — frozen</h2>
          <div className="flex flex-wrap gap-1">
            {PRESENCE_COLOURS.map(c => (
              <div
                key={c}
                className="h-6 w-6 rounded-sm border border-border"
                style={{ backgroundColor: c }}
                title={c}
              />
            ))}
          </div>
        </section>

        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-md border border-border bg-app p-3">
            <dt className="text-muted">Zoom range</dt>
            <dd className="font-medium">
              {ZOOM_MIN * 100}% – {ZOOM_MAX * 100}%
            </dd>
          </div>
          <div className="rounded-md border border-border bg-app p-3">
            <dt className="text-muted">Canvas origin</dt>
            <dd className="font-medium">
              {sample.x}, {sample.y}
            </dd>
          </div>
        </dl>
      </div>
    </main>
  )
}
