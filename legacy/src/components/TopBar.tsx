import { createContext, useContext, type ReactNode } from 'react'
import { IconMenu } from './Icons'

export const SidebarContext = createContext<{ toggle: () => void; open: boolean }>({ toggle: () => {}, open: false })

export function TopBar({ children, right }: { children?: ReactNode; right?: ReactNode }) {
  const { toggle } = useContext(SidebarContext)
  return (
    <header className="topbar">
      <button className="icon-btn menu-btn" aria-label="打开侧栏" onClick={toggle}>
        <IconMenu />
      </button>
      <div className="topbar-main">{children}</div>
      <div className="topbar-right">{right}</div>
    </header>
  )
}
