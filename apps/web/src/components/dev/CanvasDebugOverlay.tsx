import { useEffect, useState } from 'react'
import type { FrameMetrics } from '../../features/canvas/renderer/Renderer.js'

/**
 * Dev debug overlay — `?debug=1`.
 *
 * Shows viewport, zoom, object counts and live frame timing. This is NOT the
 * convergence panel from TRD §6.5 — that one shows lastAppliedSeq and a state
 * hash and arrives in Phase 11 (R-CONV-011). This is just enough to make the
 * viewport maths and the frame budget visible while building the canvas.
 *
 * Polls on an interval rather than subscribing per frame: this is a debug
 * readout, and re-rendering React at 60 Hz to display a frame counter would
 * corrupt the very number it reports.
 */

export interface DebugSnapshot {
  viewport: { x: number; y: number; zoom: number }
  totalObjects: number
  visibleObjects: number
  metrics: FrameMetrics
}

interface Props {
  read: () => DebugSnapshot
}

export function CanvasDebugOverlay({ read }: Props) {
  const [snap, setSnap] = useState<DebugSnapshot | null>(null)

  useEffect(() => {
    const id = setInterval(() => setSnap(read()), 250)
    return () => clearInterval(id)
  }, [read])

  if (!snap) return null

  const { viewport, totalObjects, visibleObjects, metrics } = snap
  const fps = metrics.p50 > 0 ? Math.round(1000 / metrics.p50) : 0

  return (
    <div
      className="pointer-events-none absolute left-4 top-4 z-panel rounded-md border border-border bg-app/95 p-3 font-mono text-[11px] leading-relaxed text-primary shadow-panel"
      data-testid="debug-overlay"
    >
      <Row label="zoom" value={`${(viewport.zoom * 100).toFixed(1)}%`} testId="dbg-zoom" />
      <Row
        label="pan"
        value={`${viewport.x.toFixed(1)}, ${viewport.y.toFixed(1)}`}
        testId="dbg-pan"
      />
      <Row
        label="objects"
        value={`${visibleObjects} / ${totalObjects}`}
        testId="dbg-objects"
      />
      <Row
        label="frame"
        value={`p50 ${metrics.p50.toFixed(1)}ms  p95 ${metrics.p95.toFixed(1)}ms`}
        testId="dbg-frame"
      />
      <Row label="fps" value={`~${fps}`} testId="dbg-fps" />
      {/* PRD §7.1 budget: input to local pixel ≤ 16 ms. */}
      <Row
        label="input"
        value={`p50 ${metrics.inputP50.toFixed(1)}ms  p95 ${metrics.inputP95.toFixed(1)}ms`}
        testId="dbg-input"
      />
      {/*
        Layer paint counts — R-CANVAS-002 made visible. Drawing a stroke should
        run the interaction number up while the objects number stays put. If
        both climb together, something is dirtying layer 1 that should not be.
      */}
      <Row
        label="paints"
        value={`obj ${metrics.objectPaints}  int ${metrics.interactionPaints}`}
        testId="dbg-paints"
      />
    </div>
  )
}

function Row({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex gap-3">
      <span className="w-14 text-muted">{label}</span>
      <span data-testid={testId}>{value}</span>
    </div>
  )
}
