/**
 * The static placeholder for a board with no thumbnail — FR-BOARD-003:
 * "Empty boards get a static placeholder graphic, not a blank white
 * rectangle".
 *
 * A quiet sketch of what a board holds — a sticky note, a shape, a stroke —
 * in the frozen sticky palette and the border/muted tokens (R-UI-002: no
 * arbitrary colours). Static: a dashboard of twenty empty boards must not
 * have twenty things moving on it.
 */
export function EmptyBoardGraphic() {
  return (
    <svg
      viewBox="0 0 160 100"
      className="h-3/5 w-3/5"
      aria-hidden="true"
      data-testid="thumb-placeholder"
    >
      <rect x="18" y="20" width="44" height="44" rx="3" className="fill-sticky-yellow" />
      <path
        d="M26 34h28M26 42h22M26 50h16"
        strokeWidth="2.5"
        strokeLinecap="round"
        className="stroke-muted/40"
      />
      <rect
        x="78"
        y="26"
        width="58"
        height="34"
        rx="4"
        strokeWidth="2.5"
        className="fill-none stroke-border"
      />
      <path
        d="M30 82c14-12 26-12 38-2s26 10 40-2 26-8 34 0"
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        className="stroke-accent/50"
      />
    </svg>
  )
}
