import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { BOARD_NAME_MAX } from '@coboard/shared'
import { Modal } from '../../components/ui/Modal.js'
import { Input } from '../../components/ui/Input.js'
import { Button } from '../../components/ui/Button.js'
import { useToast } from '../../components/ui/Toast.js'
import { actions, boardSettings, boards as boardStrings } from '../../lib/strings.js'
import { useRenameBoard, useTrashBoard } from './useBoards.js'
import { serverErrorMessage } from '../../lib/errorCopy.js'

/**
 * S-13 — the board settings modal. Owner only (PRD §6, FR-SHARE-001: "Can
 * change board settings" is the Owner's column alone), reached from the board
 * title's ▾ menu (FLOWS §1.2: "Title menu → Settings").
 *
 * Neither the PRD nor FLOWS lists the modal's contents, so they are the
 * owner-only board actions the specs DO define, and nothing invented (D-24):
 *
 *   1. Name — FR-BOARD-004 rename, the same rule as the inline title edit.
 *   2. Sharing — a door into S-12 (FR-SHARE-*), not a second copy of it.
 *   3. Danger zone — FR-BOARD-005 move to trash, behind a confirmation
 *      (FLOWS §1.2's "Delete → confirm"). On success the owner goes to the
 *      dashboard with the same "Moved to trash" toast the card menu shows;
 *      everyone else in the room gets S-19 from the server's board:deleted.
 *
 * Zone: board chrome — `ui-ux-pro-max` + `emil-design-eng`, no Framer Motion
 * (R-SKILL-060). The modal's own enter/exit is the shared Modal's.
 */
export function BoardSettingsModal({
  open,
  onClose,
  boardId,
  boardName,
  onRenamed,
  onOpenShare,
}: {
  open: boolean
  onClose: () => void
  boardId: string
  boardName: string
  /** Optimistic: the header shows the new name before the round trip. */
  onRenamed: (name: string) => void
  onOpenShare: () => void
}) {
  const [draft, setDraft] = useState(boardName)
  const [confirming, setConfirming] = useState(false)
  const rename = useRenameBoard()
  const trash = useTrashBoard()
  const toast = useToast()
  const navigate = useNavigate()

  useEffect(() => {
    if (open) {
      setDraft(boardName)
      setConfirming(false)
    }
  }, [open, boardName])

  const trimmed = draft.trim()
  const canSave = trimmed.length > 0 && trimmed !== boardName && !rename.isPending

  const onSave = (e: FormEvent) => {
    e.preventDefault()
    if (!canSave) return
    onRenamed(trimmed)
    rename.mutate(
      { id: boardId, name: trimmed },
      {
        onSuccess: () => toast.show({ message: boardSettings.renamed }),
        onError: () => {
          onRenamed(boardName)
          toast.show({ message: boardStrings.renameFailed, variant: 'danger' })
        },
      },
    )
  }

  const onTrash = () =>
    trash.mutate(boardId, {
      onSuccess: () => {
        onClose()
        navigate('/dashboard')
        toast.show({ message: boardStrings.movedToTrash })
      },
      onError: error =>
        toast.show({ message: serverErrorMessage(error), variant: 'danger' }),
    })

  if (confirming) {
    return (
      <Modal
        open={open}
        onClose={() => setConfirming(false)}
        title={boardStrings.deleteConfirmTitle(boardName)}
        destructive
        dismissible={!trash.isPending}
        testId="board-settings-confirm"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setConfirming(false)}
              disabled={trash.isPending}
            >
              {actions.cancel}
            </Button>
            <Button
              variant="danger"
              onClick={onTrash}
              disabled={trash.isPending}
              data-autofocus
              data-testid="board-settings-trash-confirm"
            >
              {actions.moveToTrash}
            </Button>
          </>
        }
      >
        <p className="text-sm text-primary">{boardStrings.deleteConfirmBody}</p>
      </Modal>
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={boardSettings.title}
      testId="board-settings"
    >
      <div className="flex flex-col gap-6">
        <form className="flex flex-col gap-3" onSubmit={onSave}>
          <Input
            label={boardStrings.nameLabel}
            value={draft}
            maxLength={BOARD_NAME_MAX}
            onChange={e => setDraft(e.target.value)}
            data-testid="board-settings-name"
          />
          <div className="flex justify-end">
            <Button type="submit" disabled={!canSave} data-testid="board-settings-save">
              {boardSettings.save}
            </Button>
          </div>
        </form>

        <section className="flex flex-col gap-2 border-t border-border pt-4">
          <h3 className="text-sm font-medium text-primary">{boardSettings.sharing}</h3>
          <p className="text-sm text-muted">{boardSettings.sharingBody}</p>
          <div>
            <Button
              variant="secondary"
              onClick={() => {
                onClose()
                onOpenShare()
              }}
              data-testid="board-settings-share"
            >
              {actions.share}
            </Button>
          </div>
        </section>

        <section className="flex flex-col gap-2 border-t border-border pt-4">
          <h3 className="text-sm font-medium text-danger">{boardSettings.dangerZone}</h3>
          <p className="text-sm text-primary">{boardSettings.dangerBody}</p>
          <div>
            <Button
              variant="danger"
              onClick={() => setConfirming(true)}
              data-testid="board-settings-trash"
            >
              {actions.moveToTrash}
            </Button>
          </div>
        </section>
      </div>
    </Modal>
  )
}
