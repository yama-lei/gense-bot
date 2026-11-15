import { Menu, WifiOff } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChatPage } from '../features/chat/ChatPage'
import { HomePage } from '../features/chat/HomePage'
import { cn } from '../lib/cn'
import { useMediaQuery, useSettled } from '../lib/hooks'
import { useProjects } from '../lib/lab'
import { Link, navigate, useRoute } from '../lib/router'
import { Button } from '../ui/button'
import { Drawer } from '../ui/dialog'
import { Empty, Spinner } from '../ui/feedback'
import { localPrefs, useClient, useHost, useLocalPrefs, useUser } from './client'
import { CommandPalette } from './CommandPalette'
import { phoneQuery, ShellContext, useShell, type ShellApi } from './shell-context'
import { Sidebar } from './Sidebar'

const PluginsPage = lazy(() => import('../features/plugins/PluginsPage'))
const AutomationsPage = lazy(() => import('../features/automations/AutomationsPage'))
const ChannelsPage = lazy(() => import('../features/channels/ChannelsPage'))
const SettingsPage = lazy(() => import('../features/settings/SettingsPage'))
const AdminPage = lazy(() => import('../features/admin/AdminPage'))
const InboxPage = lazy(() => import('../features/inbox/InboxPage'))
const ProjectsPage = lazy(() => import('../features/projects/ProjectsPage'))
const LibraryPage = lazy(() => import('../features/library/LibraryPage'))
const MemoryPage = lazy(() => import('../features/memory/MemoryPage'))

/** Opens the sidebar drawer on a phone; a desktop always has the sidebar or its rail. Pages put it first in their header. */
export function SidebarToggle({ className }: { className?: string }) {
  const { sidebarHidden, showSidebar } = useShell()
  if (!sidebarHidden) return null
  return (
    <Button variant="ghost" size="icon" aria-label="打开侧边栏" onClick={showSidebar} className={cn('text-muted-foreground', className)}>
      <Menu className="size-5!" />
    </Button>
  )
}

/**
 * A page that is not a conversation: a slim bar, then a centred column that scrolls. `wide` gives lists and grids
 * more room; `eyebrow` is the small line above the title (a section name, a badge).
 */
export function Page({
  title,
  description,
  actions,
  eyebrow,
  wide,
  children,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  eyebrow?: ReactNode
  wide?: boolean
  children: ReactNode
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-1 px-2 md:hidden">
        <SidebarToggle />
        <span className="truncate text-sm font-medium">{title}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div className={cn('mx-auto w-full animate-rise px-4 pt-3 pb-20 md:px-10 md:pt-12', wide ? 'max-w-5xl' : 'max-w-3xl')}>
          <div className="mb-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
            <div className="min-w-0">
              {eyebrow && <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">{eyebrow}</div>}
              <h1 className="text-[1.65rem] leading-tight font-semibold tracking-tight md:text-[1.9rem]">{title}</h1>
              {description && <p className="mt-2 max-w-xl text-sm text-muted-foreground">{description}</p>}
            </div>
            {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}

const loading = (
  <div className="grid h-full place-items-center">
    <Spinner className="size-5" />
  </div>
)

const titles: Record<string, string> = {
  plugins: '插件与 Skill',
  automations: '自动化',
  channels: '渠道',
  settings: '设置',
  admin: '管理后台',
  inbox: '收件箱',
  projects: '项目',
  library: '资料库',
  memory: '记忆',
}

export function Shell() {
  const route = useRoute()
  const host = useHost()
  const client = useClient()
  const user = useUser()
  const phone = useMediaQuery(phoneQuery)
  const { sidebar } = useLocalPrefs()
  const projects = useProjects()
  const [drawer, setDrawer] = useState(false)
  const [palette, setPalette] = useState(false)

  // Only the open conversation streams.
  const chatId = route.name === 'chat' && host.trees?.some((t) => t.id === route.id) ? route.id : ''
  useEffect(() => client.socket.watch(chatId ? [chatId] : []), [client, chatId])

  useEffect(() => {
    const title =
      route.name === 'chat' ? host.trees?.find((t) => t.id === route.id)?.title : route.name === 'projects' && route.id ? projects.find((p) => p.id === route.id)?.name : titles[route.name]
    document.title = title ? `${title} · Gense` : 'Gense'
  }, [route, host.trees, projects])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const key = e.key.toLowerCase()
      if (key === 'k' && !e.shiftKey) {
        e.preventDefault()
        setPalette((v) => !v)
      } else if (key === 'o' && e.shiftKey) {
        e.preventDefault()
        navigate({ name: 'home' })
      } else if (key === 'b' && !e.shiftKey) {
        e.preventDefault()
        localPrefs.set((p) => ({ ...p, sidebar: !p.sidebar }))
      } else if (key === ',' && !e.shiftKey) {
        e.preventDefault()
        navigate({ name: 'settings' })
      } else if (key === '/' && !e.shiftKey) {
        e.preventDefault()
        navigate({ name: 'settings', section: 'shortcuts' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const api = useMemo<ShellApi>(
    () => ({
      sidebarHidden: phone,
      showSidebar: () => setDrawer(true),
      openPalette: () => {
        setDrawer(false)
        setPalette(true)
      },
    }),
    [phone],
  )

  // A reconnect within a couple of seconds is not worth a banner.
  const offline = useSettled(!host.connected && host.trees !== null, 2000) && !host.connected

  let page: ReactNode
  switch (route.name) {
    case 'home':
      page = <HomePage />
      break
    case 'chat':
      page =
        host.trees === null ? (
          loading
        ) : chatId ? (
          <ChatPage key={route.id} treeId={route.id} />
        ) : (
          <Missing title="找不到这个对话">它可能已经删除，或者链接不完整。</Missing>
        )
      break
    case 'plugins':
      page = <PluginsPage tab={route.tab ?? 'plugins'} />
      break
    case 'automations':
      page = <AutomationsPage />
      break
    case 'channels':
      page = <ChannelsPage />
      break
    case 'inbox':
      page = <InboxPage />
      break
    case 'projects':
      page = <ProjectsPage id={route.id} />
      break
    case 'library':
      page = <LibraryPage />
      break
    case 'memory':
      page = <MemoryPage />
      break
    case 'settings':
      page = <SettingsPage section={route.section ?? 'personal'} />
      break
    case 'admin':
      page = user.role === 'admin' ? <AdminPage section={route.section ?? 'users'} /> : <Missing title="没有权限">只有管理员能打开管理后台。</Missing>
      break
    default:
      page = <Missing title="没有这个页面">地址可能输错了。</Missing>
  }

  return (
    <ShellContext.Provider value={api}>
      {/* The chrome is the sidebar's colour; the page sits on it as a canvas with rounded corners. */}
      <div className="flex h-dvh overflow-hidden bg-sidebar">
        {!phone && (
          <aside className={cn('shrink-0 overflow-hidden transition-[width] duration-200 ease-out', sidebar ? 'w-70' : 'w-14')}>
            <Sidebar rail={!sidebar} onNavigate={() => {}} onToggle={() => localPrefs.set((p) => ({ ...p, sidebar: !p.sidebar }))} />
          </aside>
        )}
        {phone && (
          <Drawer open={drawer} onOpenChange={setDrawer} label="侧边栏">
            <Sidebar onNavigate={() => setDrawer(false)} />
          </Drawer>
        )}
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background pt-[env(safe-area-inset-top)] md:my-2 md:mr-2 md:rounded-2xl md:shadow-canvas">
          {offline && (
            <div role="status" className="flex shrink-0 items-center justify-center gap-2 bg-warning-soft px-3 py-1.5 text-sm text-warning">
              <WifiOff className="size-4" /> 与服务器的连接已断开，正在重连…
            </div>
          )}
          <div className="min-h-0 flex-1">
            <Suspense fallback={loading}>{page}</Suspense>
          </div>
        </main>
      </div>
      <CommandPalette open={palette} onOpenChange={setPalette} />
    </ShellContext.Provider>
  )
}

function Missing({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center px-2">
        <SidebarToggle />
      </header>
      <div className="grid flex-1 place-items-center px-4">
        <Empty
          title={title}
          className="border-0"
          action={
            <Button asChild variant="primary">
              <Link to={{ name: 'home' }}>开始新对话</Link>
            </Button>
          }
        >
          {children}
        </Empty>
      </div>
    </div>
  )
}
