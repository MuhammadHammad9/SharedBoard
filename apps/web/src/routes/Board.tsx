import { Canvas } from '../features/canvas/Canvas.js'
import { SessionExpiredBanner } from '../components/board/SessionExpiredBanner.js'

/**
 * S-10 Board shell.
 *
 * The header, presence avatars, share and export are Phase 8 onward; the
 * canvas and its chrome came in Phases 2–6. What Phase 7 adds is the E-17
 * banner, which sits above everything and is why the route needs a shell at
 * all rather than rendering `<Canvas/>` directly.
 *
 * Lazy-loaded from App.tsx (TRD §12.2) so the auth screens never pull in the
 * canvas engine.
 */
export default function Board() {
  return (
    <main className="relative h-[100dvh] min-h-[100dvh] w-full overflow-hidden bg-canvas">
      <Canvas />
      <SessionExpiredBanner />
    </main>
  )
}
