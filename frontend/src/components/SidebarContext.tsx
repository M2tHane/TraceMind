import { createContext, useContext } from 'react'

interface SidebarState {
  sidebarOpen: boolean
  toggleSidebar: () => void
  closeSidebar: () => void
}

export const SidebarContext = createContext<SidebarState | null>(null)

export function useSidebar(): SidebarState {
  const state = useContext(SidebarContext)
  if (!state) throw new Error('Sidebar controls must be inside the workspace')
  return state
}
