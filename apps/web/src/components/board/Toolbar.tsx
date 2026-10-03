import { useRef } from 'react'
import {
  ArrowUpRight,
  Circle,
  Cursor,
  Eraser,
  Hand,
  Image as ImageIcon,
  LineSegment,
  Note,
  PencilSimple,
  Square,
  TextT,
  type Icon,
} from '@phosphor-icons/react'
import { ViewOnlyBadge } from './ViewOnlyBadge.js'
import { ACTIVE_TOOLS, useBoardStore, type Tool } from '../../stores/boardStore.js'
import { Tooltip } from '../ui/Tooltip.js'
import { ACCEPTED_IMAGE_TYPES } from '@coboard/shared'
import { startUploads } from '../../features/uploads/uploadEngine.js'
import { boardChrome } from '../../lib/strings.js'

/**
 * Left toolbar — FLOWS §14.2. 56 px wide, vertically centred, floating with
 * --shadow-panel, 16 px from the left edge, z-index: panel.
 *
 * Zone: Board chrome. Skills: ui-ux-pro-max + emil-design-eng, dials 4/2/6.
 * gpt-taste, high-end-visual-design and Framer Motion are all forbidden here
 * (C-5, R-SKILL-060) — and the board-chunk CI gate now enforces the last one.
 *
 * MOTION — this is the sharpest application of the frequency gate in the whole
 * product. Tool switching happens dozens to hundreds of times a session, which
 * is the top band of R-MOTION-001: **no animation, ever**. The accent
 * background appears the instant the tool changes. The only motion is
 * scale(0.97) on press (R-MOTION-033) and a 120 ms hover colour, and hover is
 * gated behind a fine pointer (R-MOTION-061) so a tap on touch does not leave
 * a button stuck looking hovered.
 *
 * All eleven tools render, because FLOWS §14.2 specifies eleven and a toolbar
 * that grows a button every fortnight relayouts under the user. The eight
 * without an implementation are DISABLED rather than hidden: a visible,
 * clearly-unavailable control is honest, where a control that selects
 * successfully and then draws nothing is a bug report.
 */

interface ToolSpec {
  tool: Tool
  icon: Icon
  label: string
  shortcut: string
}

/** Order is FLOWS §14.2, exactly. */
const TOOLS: readonly ToolSpec[] = [
  { tool: 'select', icon: Cursor, label: boardChrome.tools.select, shortcut: 'V' },
  { tool: 'hand', icon: Hand, label: boardChrome.tools.hand, shortcut: 'H' },
  { tool: 'pen', icon: PencilSimple, label: boardChrome.tools.pen, shortcut: 'P' },
  { tool: 'eraser', icon: Eraser, label: boardChrome.tools.eraser, shortcut: 'E' },
  { tool: 'rect', icon: Square, label: boardChrome.tools.rect, shortcut: 'R' },
  { tool: 'ellipse', icon: Circle, label: boardChrome.tools.ellipse, shortcut: 'O' },
  { tool: 'line', icon: LineSegment, label: boardChrome.tools.line, shortcut: 'L' },
  { tool: 'arrow', icon: ArrowUpRight, label: boardChrome.tools.arrow, shortcut: 'A' },
  { tool: 'sticky', icon: Note, label: boardChrome.tools.sticky, shortcut: 'N' },
  { tool: 'text', icon: TextT, label: boardChrome.tools.text, shortcut: 'T' },
  { tool: 'image', icon: ImageIcon, label: boardChrome.tools.image, shortcut: '' },
]

export function Toolbar() {
  // Narrow selectors — R-ARCH-003. The toolbar re-renders on a tool change and
  // on nothing else; it must never see the object map.
  const activeTool = useBoardStore(s => s.activeTool)
  const setActiveTool = useBoardStore(s => s.setActiveTool)
  const interactionType = useBoardStore(s => s.interaction.type)
  const readOnly = useBoardStore(s => s.readOnly)
  const fileInput = useRef<HTMLInputElement>(null)

  // R-CANVAS-055 / FLOWS E-08: a tool change mid-interaction is ignored, not
  // queued into a half-finished stroke.
  const locked = interactionType !== 'IDLE'

  // FR-SHARE-006: a viewer's toolbar is the badge, nothing else.
  if (readOnly) return <ViewOnlyBadge />

  return (
    <div
      className="pointer-events-auto absolute left-4 top-1/2 z-panel flex -translate-y-1/2 flex-col gap-1 rounded-md border border-border bg-app p-1 shadow-panel"
      role="toolbar"
      aria-orientation="vertical"
      aria-label={boardChrome.tools.label}
      data-testid="toolbar"
    >
      {TOOLS.map(({ tool, icon: IconComponent, label, shortcut }) => {
        const isImage = tool === 'image'
        const implemented = isImage || ACTIVE_TOOLS.includes(tool)
        const active = !isImage && activeTool === tool
        return (
          <Tooltip
            key={tool}
            label={implemented ? label : boardChrome.tools.comingLater(label)}
            shortcut={implemented ? shortcut : undefined}
          >
            <button
              type="button"
              // R-A11Y-002: icon-only buttons need an accessible name.
              aria-label={label}
              // The button IS the state, so expose it rather than relying on
              // the accent background alone.
              aria-pressed={active}
              disabled={!implemented || (locked && !active)}
              data-testid={`tool-${tool}`}
              onClick={() => (isImage ? fileInput.current?.click() : setActiveTool(tool))}
              className={
                'flex h-10 w-10 cursor-pointer items-center justify-center rounded-sm ' +
                // Colour only. No transform on hover, no transform on the
                // active state — R-MOTION-001, top band.
                'transition-colors duration-fast ease-standard active:scale-[0.97] ' +
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ' +
                'disabled:cursor-not-allowed disabled:opacity-40 ' +
                (active
                  ? 'bg-accent text-white'
                  : 'text-primary hover:bg-subtle disabled:hover:bg-transparent')
              }
            >
              <IconComponent size={20} weight="light" aria-hidden="true" />
            </button>
          </Tooltip>
        )
      })}
      {/* FR-CANVAS-010: Image is an action, not a mode — it opens the file
          picker, and the chosen files go to the centre of the view. */}
      <input
        ref={fileInput}
        type="file"
        accept={ACCEPTED_IMAGE_TYPES.join(',')}
        multiple
        hidden
        // Never a tab stop: the Image button is the control; this is plumbing.
        tabIndex={-1}
        data-testid="image-file-input"
        onChange={e => {
          const files = Array.from(e.target.files ?? [])
          // Cleared, so choosing the same file again still fires `change`.
          e.target.value = ''
          if (files.length > 0) void startUploads(files)
        }}
      />
    </div>
  )
}
