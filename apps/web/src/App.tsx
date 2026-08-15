import { Canvas } from './features/canvas/Canvas.js'

/**
 * Phase 2 shell.
 *
 * Renders the canvas directly. React Router arrives in Phase 7 alongside the
 * auth guards — adding it now would mean writing route guards with no auth to
 * guard, and the board route shell (S-10 header, toolbar, panels) is Phase 3
 * and later.
 *
 * `min-h-[100dvh]`, never `h-screen` — R-UI-041, avoids the iOS Safari
 * address-bar viewport jump.
 */
export default function App() {
  return (
    <main className="h-[100dvh] min-h-[100dvh] w-full overflow-hidden bg-canvas">
      <Canvas />
    </main>
  )
}
