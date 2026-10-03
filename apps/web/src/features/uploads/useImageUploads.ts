import { useEffect } from 'react'
import { useToast } from '../../components/ui/Toast.js'
import { boardStore } from '../../stores/boardStore.js'
import { setUploadContext } from './uploadEngine.js'

/**
 * Wires the upload engine to this board: its id, the toast, and the visible
 * area (canvas coordinates) for placing pasted and picked images (D13-5).
 * The canvas fills the window on the board route, so the window is the view.
 */
export function useImageUploads(boardId: string | undefined): void {
  const toast = useToast()

  useEffect(() => {
    if (!boardId) return
    setUploadContext({
      boardId,
      notify: message => toast.show({ message, variant: 'danger' }),
      visibleArea: () => {
        const { x, y, zoom } = boardStore.getState().viewport
        return {
          x: -x / zoom,
          y: -y / zoom,
          width: window.innerWidth / zoom,
          height: window.innerHeight / zoom,
        }
      },
    })
    return () => setUploadContext(null)
  }, [boardId, toast])
}
