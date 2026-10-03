import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { THUMBNAIL_INTERVAL_MS } from '@coboard/shared'
import { api } from '../../lib/api.js'
import { boardStore, objectsInZOrder } from '../../stores/boardStore.js'
import { renderThumbnail } from '../canvas/thumbnail.js'

/**
 * Keeps the board's dashboard thumbnail current — FR-BOARD-003: "regenerated
 * on the client when a board session ends or every 5 minutes of active
 * editing, whichever comes first".
 *
 *   every 5 minutes   only if the board changed since the last one
 *   session end       leaving the board (unmount) or the tab (pagehide /
 *                     hidden), only if it changed; sent with `keepalive`
 *                     so the request outlives the page
 *
 * Editors only: the server refuses a viewer's thumbnail anyway (D13-4), and a
 * viewer's client has nothing to report. An empty board CLEARS its thumbnail.
 */
export function useThumbnailUpkeep(boardId: string | undefined, enabled: boolean): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!boardId || !enabled) return
    // Whatever is on screen at entry is what the dashboard already shows.
    let sentVersion = boardStore.getState().objectsVersion

    const send = (keepalive: boolean) => {
      const { objectsVersion } = boardStore.getState()
      if (objectsVersion === sentVersion) return
      sentVersion = objectsVersion

      const objects = objectsInZOrder()
      const blob = objects.length > 0 ? renderThumbnail(objects) : null
      const request =
        objects.length === 0
          ? api.del(`/boards/${boardId}/thumbnail`, { keepalive })
          : blob
            ? api.put(`/boards/${boardId}/thumbnail`, blob, { keepalive })
            : null
      // The dashboard's cached list is stale once this lands.
      void request
        ?.then(() => queryClient.invalidateQueries({ queryKey: ['boards'] }))
        .catch(() => {
          // Best effort. The next change, or the next session, tries again.
        })
    }

    const timer = window.setInterval(() => send(false), THUMBNAIL_INTERVAL_MS)
    const onHide = () => {
      if (document.visibilityState === 'hidden') send(true)
    }
    const onPageHide = () => send(true)
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', onPageHide)

    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onPageHide)
      // Leaving the board is the end of the session.
      send(true)
    }
  }, [boardId, enabled, queryClient])
}
