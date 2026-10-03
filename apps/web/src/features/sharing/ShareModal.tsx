import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, LinkSimple, X } from '@phosphor-icons/react'
import { actions, sharing } from '../../lib/strings.js'
import { ApiError } from '../../lib/api.js'
import { Modal } from '../../components/ui/Modal.js'
import { Button } from '../../components/ui/Button.js'
import { useToast } from '../../components/ui/Toast.js'
import { track } from '../../lib/analytics.js'
import { useSharing } from './useSharing.js'
import type { LinkRole, Member } from './api.js'

/**
 * S-12 — the share modal. FLOWS §10, FR-SHARE-002/003/004.
 *
 *   Invite by email      chips; an invalid address is a red chip and blocks Send
 *   People with access   per-member role, optimistic with revert; Remove
 *   General access       Restricted / Anyone with the link · can edit / can view
 *                        Copy (with a real fallback) · Reset link (confirmed)
 *
 * Zone: board chrome. No Framer Motion (R-SKILL-060): the modal uses the
 * shared opacity + 8 px entry, and the two micro-animations here — the Copy
 * label swap and the role-change flash — are CSS on opacity only. See
 * index.css.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const isMac = () => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '')

export function ShareModal({
  open,
  onClose,
  boardId,
  boardName,
}: {
  open: boolean
  onClose: () => void
  boardId: string
  boardName: string
}) {
  const data = useSharing(boardId, open)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={sharing.title(boardName)}
      wide
      sheetOnMobile
      testId="share-modal"
    >
      <div className="flex flex-col gap-6">
        <InviteSection onInvite={data.invite} />
        <PeopleSection data={data} />
        <LinkSection data={data} />
      </div>
    </Modal>
  )
}

/* ── Invite by email ──────────────────────────────────────────────────────── */

function InviteSection({
  onInvite,
}: {
  onInvite: (
    emails: string[],
    role: LinkRole,
  ) => Promise<{ added: string[]; invited: string[] }>
}) {
  const toast = useToast()
  const [chips, setChips] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [role, setRole] = useState<LinkRole>('EDITOR')
  const [sending, setSending] = useState(false)

  const commitDraft = (): string[] => {
    const parts = draft
      .split(/[,\s]+/)
      .map(p => p.trim())
      .filter(Boolean)
    if (parts.length === 0) return chips
    const next = [...chips, ...parts.filter(p => !chips.includes(p))]
    setChips(next)
    setDraft('')
    return next
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      commitDraft()
    } else if (e.key === 'Backspace' && draft === '' && chips.length > 0) {
      setChips(chips.slice(0, -1))
    }
  }

  const all = [...chips, ...draft.split(/[,\s]+/).filter(Boolean)]
  const invalid = all.filter(e => !EMAIL.test(e))
  const canSend = all.length > 0 && invalid.length === 0 && !sending

  const send = async () => {
    const emails = commitDraft()
    if (emails.length === 0 || emails.some(e => !EMAIL.test(e))) return
    setSending(true)
    try {
      const { added, invited } = await onInvite(emails, role)
      toast.show({ message: sharing.invitesSent(added.length + invited.length) })
      setChips([])
    } catch (error) {
      toast.show({
        message: error instanceof ApiError ? error.message : sharing.linkUpdateFailed,
        variant: 'danger',
      })
    } finally {
      setSending(false)
    }
  }

  return (
    <section aria-labelledby="share-invite" className="flex flex-col gap-2">
      <h3 id="share-invite" className="text-sm font-medium text-primary">
        {sharing.inviteHeading}
      </h3>
      <div className="flex items-start gap-2">
        <div className="flex min-h-[36px] flex-1 flex-wrap items-center gap-1 rounded-md border border-border bg-app px-2 py-1 focus-within:border-accent">
          {chips.map(chip => {
            const bad = !EMAIL.test(chip)
            return (
              <span
                key={chip}
                data-testid="invite-chip"
                data-invalid={bad ? 'true' : 'false'}
                title={bad ? sharing.invalidEmail(chip) : undefined}
                className={`flex items-center gap-1 rounded-sm px-2 py-0.5 text-xs ${bad ? 'border border-danger/30 bg-app text-danger' : 'bg-subtle text-primary'}`}
              >
                {chip}
                <button
                  type="button"
                  aria-label={`${actions.remove} ${chip}`}
                  onClick={() => setChips(chips.filter(c => c !== chip))}
                  className="cursor-pointer text-muted hover:text-primary"
                >
                  <X size={10} weight="bold" aria-hidden="true" />
                </button>
              </span>
            )
          })}
          <input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => commitDraft()}
            placeholder={chips.length === 0 ? sharing.invitePlaceholder : ''}
            aria-label={sharing.inviteHeading}
            aria-invalid={invalid.length > 0 ? true : undefined}
            className="min-w-[8rem] flex-1 bg-transparent py-1 text-sm text-primary outline-none placeholder:text-muted"
            data-testid="invite-input"
          />
        </div>
        <select
          value={role}
          onChange={e => setRole(e.target.value as LinkRole)}
          aria-label={sharing.inviteRole}
          className="h-9 cursor-pointer rounded-md border border-border bg-app px-2 text-sm text-primary"
          data-testid="invite-role"
        >
          <option value="EDITOR">{sharing.editor}</option>
          <option value="VIEWER">{sharing.viewer}</option>
        </select>
        <Button
          onClick={() => void send()}
          disabled={!canSend}
          loading={sending}
          data-testid="invite-send"
        >
          {sharing.send}
        </Button>
      </div>
      {invalid.length > 0 && (
        <p className="text-xs text-danger" role="alert">
          {sharing.invalidEmail(invalid[0]!)}
        </p>
      )}
    </section>
  )
}

/* ── People with access ───────────────────────────────────────────────────── */

function PeopleSection({ data }: { data: ReturnType<typeof useSharing> }) {
  const toast = useToast()
  const [confirming, setConfirming] = useState<string | null>(null)
  const editors = data.members.filter(m => m.role === 'EDITOR').length

  const onRemove = async (member: Member) => {
    // FLOWS §10.2: "Confirmation only for the last editor".
    if (member.role === 'EDITOR' && editors === 1 && confirming !== member.id) {
      setConfirming(member.id)
      return
    }
    setConfirming(null)
    if (!(await data.remove(member.id))) {
      toast.show({ message: sharing.removeFailed, variant: 'danger' })
    }
  }

  return (
    <section aria-labelledby="share-people" className="flex flex-col gap-2">
      <h3 id="share-people" className="text-sm font-medium text-primary">
        {sharing.peopleHeading}
      </h3>
      <ul className="flex flex-col" data-testid="member-list">
        {data.members.map(member => (
          <li
            key={member.id}
            data-member-row
            data-flash={data.flashed === member.id ? 'true' : 'false'}
            className="relative flex items-center gap-3 rounded-md px-1 py-2"
            data-testid="member-row"
          >
            <span
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-subtle text-xs font-semibold text-primary"
            >
              {member.name.charAt(0).toUpperCase()}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm text-primary">
                {member.name}
                {member.kind === 'guest' ? ` ${sharing.guestSuffix}` : ''}
              </span>
              <span className="truncate text-xs text-muted">{member.email ?? '—'}</span>
            </span>
            {member.isOwner ? (
              <span className="text-xs text-muted">{sharing.owner}</span>
            ) : (
              <>
                <select
                  value={member.role}
                  aria-label={sharing.roleFor(member.name)}
                  onChange={async e => {
                    const ok = await data.changeRole(
                      member.id,
                      e.target.value as LinkRole,
                    )
                    if (!ok)
                      toast.show({ message: sharing.roleChangeFailed, variant: 'danger' })
                  }}
                  className="h-8 cursor-pointer rounded-md border border-border bg-app px-2 text-xs text-primary"
                  data-testid="member-role"
                >
                  <option value="EDITOR">{sharing.editor}</option>
                  <option value="VIEWER">{sharing.viewer}</option>
                </select>
                <button
                  type="button"
                  onClick={() => void onRemove(member)}
                  className="cursor-pointer rounded-sm text-xs text-danger outline-none hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  data-testid="member-remove"
                >
                  {confirming === member.id ? `${sharing.remove}?` : sharing.remove}
                </button>
              </>
            )}
          </li>
        ))}
        {data.invites.map(invite => (
          <li
            key={invite.email}
            className="flex items-center gap-3 px-1 py-2 text-sm text-muted"
          >
            <span className="h-7 w-7 shrink-0 rounded-full border border-dashed border-border" />
            <span className="flex-1 truncate">{invite.email}</span>
            <span className="text-xs">{sharing.invited}</span>
          </li>
        ))}
      </ul>
      {confirming && (
        <p className="text-xs text-danger" role="alert">
          {sharing.removeLastEditor(
            data.members.find(m => m.id === confirming)?.name ?? '',
          )}
        </p>
      )}
    </section>
  )
}

/* ── General access ───────────────────────────────────────────────────────── */

function LinkSection({ data }: { data: ReturnType<typeof useSharing> }) {
  const toast = useToast()
  const [copied, setCopied] = useState(false)
  const [fallback, setFallback] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [busy, setBusy] = useState(false)
  const urlRef = useRef<HTMLInputElement | null>(null)
  const url = data.link ? `${location.origin}${data.link.url}` : ''

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 2_000)
    return () => clearTimeout(id)
  }, [copied])

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } catch {
      toast.show({ message: sharing.linkUpdateFailed, variant: 'danger' })
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setFallback(false)
      setCopied(true)
      track('share_link_copied')
    } catch {
      // FLOWS §10.2: a REAL fallback — select the text, say how to copy it.
      setFallback(true)
      urlRef.current?.focus()
      urlRef.current?.select()
    }
  }

  return (
    <section aria-labelledby="share-general" className="flex flex-col gap-2">
      <h3 id="share-general" className="text-sm font-medium text-primary">
        {sharing.generalHeading}
      </h3>
      <div className="flex items-center gap-2">
        <LinkSimple size={16} weight="light" aria-hidden="true" className="text-muted" />
        <select
          value={data.link ? 'anyone' : 'restricted'}
          disabled={busy || data.loading}
          aria-label={sharing.generalHeading}
          onChange={e =>
            void run(async () => {
              const link = await data.setAccess(
                e.target.value === 'anyone' ? 'EDITOR' : null,
              )
              if (link) track('share_link_created')
            })
          }
          className="h-8 cursor-pointer rounded-md border border-border bg-app px-2 text-sm text-primary"
          data-testid="link-access"
        >
          <option value="restricted">{sharing.restricted}</option>
          <option value="anyone">{sharing.anyoneWithLink}</option>
        </select>
        {data.link && (
          <select
            value={data.link.role}
            disabled={busy}
            aria-label={sharing.anyoneWithLink}
            onChange={e => void run(() => data.setAccess(e.target.value as LinkRole))}
            className="h-8 cursor-pointer rounded-md border border-border bg-app px-2 text-sm text-primary"
            data-testid="link-role"
          >
            <option value="EDITOR">{sharing.canEdit}</option>
            <option value="VIEWER">{sharing.canView}</option>
          </select>
        )}
      </div>

      {data.link && (
        <>
          <div className="flex items-center gap-2">
            <input
              ref={urlRef}
              readOnly
              value={url}
              aria-label={sharing.anyoneWithLink}
              onFocus={e => e.currentTarget.select()}
              className="h-9 min-w-0 flex-1 rounded-md border border-border bg-subtle px-2 text-xs text-primary"
              data-testid="link-url"
            />
            <Button
              variant="secondary"
              onClick={() => void copy()}
              data-testid="link-copy"
            >
              <span
                data-copy-label
                data-copied={copied ? 'true' : 'false'}
                className="flex items-center gap-1"
              >
                {copied ? (
                  <>
                    <Check size={14} weight="bold" aria-hidden="true" />
                    {actions.copied}
                  </>
                ) : (
                  actions.copy
                )}
              </span>
            </Button>
          </div>
          {fallback && (
            <p className="text-xs text-muted" role="status" data-testid="copy-fallback">
              {sharing.copyFallback(isMac() ? 'Cmd' : 'Ctrl')}
            </p>
          )}

          <button
            type="button"
            onClick={() => setConfirmReset(true)}
            className="self-start cursor-pointer rounded-sm text-xs font-medium text-accent outline-none hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="link-reset"
          >
            {actions.resetLink}
          </button>
          {/* FLOWS §10.2: "Confirmation modal: Anyone using the old link will
              lose access." Stacked over this one; Escape closes only it. */}
          <Modal
            open={confirmReset}
            onClose={() => setConfirmReset(false)}
            title={actions.resetLink}
            testId="reset-confirm"
            destructive
            dismissible={!busy}
            footer={
              <>
                <Button variant="secondary" onClick={() => setConfirmReset(false)}>
                  {actions.cancel}
                </Button>
                <Button
                  variant="danger"
                  onClick={() =>
                    void run(async () => {
                      await data.reset()
                      setConfirmReset(false)
                    })
                  }
                  loading={busy}
                  // FLOWS §13.2: a confirmation opens on its primary action.
                  data-autofocus
                  data-testid="reset-confirm-yes"
                >
                  {actions.resetLink}
                </Button>
              </>
            }
          >
            {sharing.resetConfirm}
          </Modal>
        </>
      )}
    </section>
  )
}
