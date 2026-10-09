import { useCallback, useEffect, useState } from 'react'
import {
  disableShareLink,
  getShareLink,
  inviteMembers,
  listMembers,
  removeMember,
  resetShareLink,
  setMemberRole,
  setShareLink,
  type LinkRole,
  type Member,
  type PendingInvite,
  type ShareLinkView,
} from './api.js'

/**
 * The share modal's data — FLOWS §10.2.
 *
 * Role changes and removals are OPTIMISTIC: the row changes at once and goes
 * back, with a toast, if the server refuses. A member list that waits a round
 * trip before acknowledging a click feels broken; one that lies about the
 * outcome is broken. Reverting on failure is the honest middle.
 */

export interface SharingState {
  loading: boolean
  members: Member[]
  invites: PendingInvite[]
  link: ShareLinkView | null
}

export function useSharing(boardId: string, open: boolean) {
  const [state, setState] = useState<SharingState>({
    loading: true,
    members: [],
    invites: [],
    link: null,
  })
  /** Rows that just changed role — the 400 ms success flash. */
  const [flashed, setFlashed] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const [{ members, invites }, { link }] = await Promise.all([
      listMembers(boardId),
      getShareLink(boardId),
    ])
    setState({ loading: false, members, invites, link })
  }, [boardId])

  useEffect(() => {
    if (!open) return
    setState(s => ({ ...s, loading: true }))
    void reload().catch(() => setState(s => ({ ...s, loading: false })))
  }, [open, reload])

  const changeRole = useCallback(
    async (memberId: string, role: LinkRole): Promise<boolean> => {
      let previous: Member['role'] | undefined
      setState(s => ({
        ...s,
        members: s.members.map(m => {
          if (m.id !== memberId) return m
          previous = m.role
          return { ...m, role }
        }),
      }))
      try {
        await setMemberRole(boardId, memberId, role)
        setFlashed(memberId)
        return true
      } catch {
        setState(s => ({
          ...s,
          members: s.members.map(m =>
            m.id === memberId && previous ? { ...m, role: previous } : m,
          ),
        }))
        return false
      }
    },
    [boardId],
  )

  const remove = useCallback(
    async (memberId: string): Promise<boolean> => {
      let removed: Member | undefined
      setState(s => {
        removed = s.members.find(m => m.id === memberId)
        return { ...s, members: s.members.filter(m => m.id !== memberId) }
      })
      try {
        await removeMember(boardId, memberId)
        return true
      } catch {
        if (removed) {
          const restore = removed
          setState(s => ({ ...s, members: [...s.members, restore] }))
        }
        return false
      }
    },
    [boardId],
  )

  const invite = useCallback(
    async (emails: string[], role: LinkRole) => {
      const result = await inviteMembers(boardId, emails, role)
      await reload()
      return result
    },
    [boardId, reload],
  )

  /** "Anyone with the link" with a role, or Restricted when `role` is null. */
  const setAccess = useCallback(
    async (role: LinkRole | null) => {
      const { link } = role
        ? await setShareLink(boardId, role)
        : await disableShareLink(boardId)
      setState(s => ({ ...s, link }))
      return link
    },
    [boardId],
  )

  const reset = useCallback(async () => {
    const { link } = await resetShareLink(boardId)
    setState(s => ({ ...s, link }))
  }, [boardId])

  return { ...state, flashed, changeRole, remove, invite, setAccess, reset, reload }
}
