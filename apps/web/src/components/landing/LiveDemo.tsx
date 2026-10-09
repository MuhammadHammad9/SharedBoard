import { useEffect, useState } from 'react'
import { landing } from '../../lib/strings.js'

/**
 * The S-01 hero demo — FLOWS §3.1 step 1: "a live looping demo of two cursors
 * drawing".
 *
 * An SVG, not the canvas engine: the landing chunk must not pull in the
 * renderer (TRD §12.2), and this is a picture of the product, not the product.
 * SMIL drives it, so it scales with the viewBox at any width and costs no
 * JavaScript per frame. The two presence colours are from the frozen palette
 * (R-UI-013) so the picture matches what a real board looks like.
 *
 * One 8 s loop: Priya draws 0–3.5 s, Marcus 2–5.5 s, a hold, then a fade
 * and a restart. Under `prefers-reduced-motion` the finished frame renders
 * still — the information survives, the movement does not (R-MOTION-060).
 */

const LOOP = '8s'
const PRIYA = '#3B82F6'
const MARCUS = '#EC4899'
const PRIYA_PATH = 'M70 236 C 130 140, 180 280, 240 190 S 330 120, 392 176'
const MARCUS_PATH = 'M262 92 C 300 70, 360 78, 384 110 C 404 138, 372 160, 336 150'

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

export function LiveDemo() {
  const [still, setStill] = useState(prefersReducedMotion)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setStill(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return (
    <svg
      viewBox="0 0 460 300"
      className="block h-auto w-full"
      role="img"
      aria-label={landing.demoLabel}
      data-testid="landing-demo"
    >
      {/* A sticky note already on the board. */}
      <g>
        <rect x="56" y="44" width="112" height="96" rx="4" fill="#FEF08A" />
        <rect x="72" y="66" width="72" height="6" rx="3" fill="#18181B" opacity="0.35" />
        <rect x="72" y="82" width="56" height="6" rx="3" fill="#18181B" opacity="0.35" />
        <rect x="72" y="98" width="64" height="6" rx="3" fill="#18181B" opacity="0.35" />
      </g>

      <g>
        {!still && (
          <animate
            attributeName="opacity"
            values="1;1;0;0"
            keyTimes="0;0.86;0.96;1"
            dur={LOOP}
            repeatCount="indefinite"
          />
        )}
        <Stroke d={PRIYA_PATH} colour={PRIYA} still={still} from={0} to={0.44} />
        <Stroke d={MARCUS_PATH} colour={MARCUS} still={still} from={0.25} to={0.69} />
        <Cursor
          d={PRIYA_PATH}
          colour={PRIYA}
          name="Priya"
          still={still}
          from={0}
          to={0.44}
        />
        <Cursor
          d={MARCUS_PATH}
          colour={MARCUS}
          name="Marcus"
          still={still}
          from={0.25}
          to={0.69}
        />
      </g>
    </svg>
  )
}

interface Segment {
  d: string
  colour: string
  still: boolean
  /** Fractions of the loop during which this one draws. */
  from: number
  to: number
}

function Stroke({ d, colour, still, from, to }: Segment) {
  return (
    <path
      d={d}
      pathLength={1}
      fill="none"
      stroke={colour}
      strokeWidth={4}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeDasharray="1"
      strokeDashoffset={still ? 0 : 1}
    >
      {!still && (
        <animate
          attributeName="stroke-dashoffset"
          values="1;1;0;0"
          keyTimes={`0;${from};${to};1`}
          dur={LOOP}
          repeatCount="indefinite"
        />
      )}
    </path>
  )
}

function Cursor({ d, colour, name, still, from, to }: Segment & { name: string }) {
  const end = endPoint(d)
  const pill = name.length * 7 + 14
  const glyph = (
    <>
      <path
        d="M0 0 L0 15 L4 11 L7 18 L10 17 L7 10 L12 10 Z"
        fill={colour}
        stroke="#FFFFFF"
        strokeWidth={1.2}
      />
      <rect x="12" y="14" width={pill} height="18" rx="9" fill={colour} />
      {/* Dark text on the presence colour: ≥ 5:1 for both colours here. */}
      <text
        x={12 + pill / 2}
        y="27"
        textAnchor="middle"
        fontSize="11"
        fontWeight="600"
        fill="#18181B"
      >
        {name}
      </text>
    </>
  )
  if (still) return <g transform={`translate(${end.x} ${end.y})`}>{glyph}</g>
  return (
    <g>
      {glyph}
      <animateMotion
        path={d}
        keyPoints="0;0;1;1"
        keyTimes={`0;${from};${to};1`}
        calcMode="linear"
        dur={LOOP}
        repeatCount="indefinite"
      />
    </g>
  )
}

/** The last coordinate pair of a path string — where a still cursor rests. */
function endPoint(d: string): { x: number; y: number } {
  const numbers = d.match(/-?\d+(\.\d+)?/g) ?? ['0', '0']
  return { x: Number(numbers.at(-2)), y: Number(numbers.at(-1)) }
}
