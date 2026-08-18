import { useEffect, useRef, useState } from 'react'
import { BOARD_NAME_MAX } from '@coboard/shared'

/**
 * Inline rename — FLOWS §6.6, used by the board card and the board header.
 *
 * Four behaviours, each of which is a complaint if missing:
 *
 * - The text is SELECTED on mount, not just focused. "Untitled board" should
 *   vanish on the first keystroke; making the user select-all first is the
 *   difference between renaming a board and fighting an input.
 * - Enter and blur both commit. Escape reverts. A rename that can only be
 *   confirmed with the mouse is not inline editing.
 * - An empty or unchanged name is a CANCEL, not a save. Clearing the field and
 *   tabbing away must not produce a board with no name.
 * - `maxLength` matches the server's limit, so the field simply stops rather
 *   than letting the user type 40 characters that will be rejected.
 */
export function RenameInline({
  value,
  onCommit,
  onCancel,
  testId = 'rename-input',
  className = '',
}: {
  value: string
  onCommit: (name: string) => void
  onCancel: () => void
  testId?: string
  className?: string
}) {
  const [draft, setDraft] = useState(value)
  const input = useRef<HTMLInputElement | null>(null)
  const committed = useRef(false)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const commit = () => {
    if (committed.current) return
    committed.current = true
    const next = draft.trim()
    if (next.length === 0 || next === value) onCancel()
    else onCommit(next)
  }

  return (
    <input
      ref={input}
      value={draft}
      maxLength={BOARD_NAME_MAX}
      aria-label="Board name"
      data-testid={testId}
      onChange={event => setDraft(event.target.value)}
      onClick={event => event.stopPropagation()}
      onBlur={commit}
      onKeyDown={event => {
        event.stopPropagation()
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          committed.current = true
          onCancel()
        }
      }}
      className={`w-full rounded-sm border border-accent bg-app px-1 text-sm font-medium text-primary outline-none ${className}`}
    />
  )
}
