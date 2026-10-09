import { Modal } from '../ui/Modal.js'
import { shortcuts } from '../../lib/strings.js'
import { closeShortcuts, useShortcutsStore } from './shortcutsStore.js'

/**
 * S-15 — keyboard shortcuts, FR-SET-003. Opened with `?` (and from the
 * header). Lists PRD Appendix A in full, in its order, with the platform's
 * own modifier: ⌘ on Apple devices, Ctrl elsewhere.
 *
 * Zone: board chrome. The shared modal motion, nothing added.
 */

const isApple = () => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '')

export function ShortcutsModal() {
  const open = useShortcutsStore(s => s.open)
  const mod = isApple() ? '⌘' : 'Ctrl'
  return (
    <Modal
      open={open}
      onClose={closeShortcuts}
      title={shortcuts.title}
      testId="shortcuts-modal"
      wide
    >
      <div
        // A scroll region must be reachable by keyboard (WCAG 2.1.1).
        tabIndex={0}
        role="region"
        aria-label={shortcuts.title}
        className="max-h-[60vh] overflow-y-auto rounded-sm pr-1 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <table className="w-full text-left text-sm">
          <tbody>
            {shortcuts.rows.map(([keys, action, context]) => (
              <tr
                key={`${keys.join('+')}-${action}`}
                className="border-b border-border last:border-0"
              >
                <td className="py-2 pr-4">
                  <span className="flex flex-wrap items-center gap-1">
                    {keys.map((key, i) => (
                      <kbd
                        key={i}
                        className="rounded-sm border border-border bg-subtle px-2 py-1 font-sans text-xs text-primary"
                      >
                        {key === 'Mod' ? mod : key}
                      </kbd>
                    ))}
                  </span>
                </td>
                <td className="py-2 pr-4 text-primary">{action}</td>
                <td className="py-2 text-xs text-muted">{shortcuts.contexts[context]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-xs text-muted">{shortcuts.rule}</p>
    </Modal>
  )
}
