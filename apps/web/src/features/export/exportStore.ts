import { create } from 'zustand'

/** Whether S-14 is open — the toolbar button and Cmd+Shift+E both set it. */
export const useExportStore = create<{ open: boolean }>(() => ({ open: false }))

export const openExport = () => useExportStore.setState({ open: true })
export const closeExport = () => useExportStore.setState({ open: false })
