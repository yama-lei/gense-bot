import { createContext, useContext } from 'react'

export interface ShellApi {
  /** The sidebar is out of sight: collapsed on a desktop, or a drawer on a phone. */
  sidebarHidden: boolean
  showSidebar(): void
  openPalette(): void
}

export const ShellContext = createContext<ShellApi>({ sidebarHidden: false, showSidebar() {}, openPalette() {} })
export const useShell = () => useContext(ShellContext)

/** True below Tailwind's `md`, where the sidebar is a drawer and panels cover the page. */
export const phoneQuery = '(max-width: 767px)'
