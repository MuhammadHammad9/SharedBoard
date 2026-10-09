import { create } from 'zustand'

/** Whether S-15 is open — the `?` key and the header both set it. */
export const useShortcutsStore = create<{ open: boolean }>(() => ({ open: false }))

export const openShortcuts = () => useShortcutsStore.setState({ open: true })
export const closeShortcuts = () => useShortcutsStore.setState({ open: false })
