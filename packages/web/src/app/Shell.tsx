import { PanelLeft, WifiOff } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChatPage } from '../features/chat/ChatPage'
import { HomePage } from '../features/chat/HomePage'
import { cn } from '../lib/cn'
import { useMediaQuery, useSettled } from '../lib/hooks'
import { Link, navigate, useRoute } from '../lib/router'
import { Button } from '../ui/button'
import { Drawer } from '../ui/dialog'
import { Empty, Spinner } from '../ui/feedback'
import { Tooltip } from '../ui/tooltip'
import { localPrefs, useClient, useHost, useLocalPrefs, useUser } from './client'
import { CommandPalette } from './CommandPalette'
import { phoneQuery, ShellContext, useShell, type ShellApi } from './shell-context'
import { Sidebar } from './Sidebar'

const PluginsPage = lazy(() => import('../features/plugins/PluginsPage'))
const AutomationsPage = lazy(() => import('../features/automations/AutomationsPage'))
const ChannelsPage = lazy(() => import('../features/channels/ChannelsPage'))
const SettingsPage = lazy(() => import('../features/settings/SettingsPage'))
const AdminPage = lazy(() => import('../features/admin/AdminPage'))

/** The button that brings the sidebar back; pages put it at the start of their header. */
export function SidebarToggle({ className }: { className?: string }) {
  const { sidebarHidden, showSidebar } = useShell()
  if (!sidebarHidden) return null
  return (
    <Tooltip label="打开侧边栏">
      <Button variant="ghost" size="icon" aria-label="打开侧边栏" onClick={showSidebar} className={cn('text-muted-foreground', className)}>
        <PanelLeft className="size-5!" />
      </Button>
    </Tooltip>
  )
}

/** A settings-style page: a header with the title, and a centred column that scrolls. */
export function Page({ title, description, actions, children }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-13 shrink-0 items-center gap-1 px-2 md:px-3">
        <SidebarToggle />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 pt-2 pb-16 md:px-8">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <h1 className="font-serif text-2xl md:text-[1.75rem]">{title}</h1>
              {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
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

export function Shell() {
  const route = useRoute()
  const host = useHost()
  const client = useClient()
  const user = useUser()
  const phone = useMediaQuery(phoneQuery)
  const { sidebar } = useLocalPrefs()
  const [drawer, setDrawer] = useState(false)
  const [palette, setPalette] = useState(false)

  // Only the open conversation streams.
  const chatId = route.name === 'chat' && host.trees?.some((t) => t.id === route.id) ? route.id : ''
  useEffect(() => client.socket.watch(chatId ? [chatId] : []), [client, chatId])

  useEffect(() => {
    const titles: Record<string, string> = { plugins: '插件与 Skill', automations: '自动化', channels: '机器人渠道', settings: '设置', admin: '管理后台' }
    const title = route.name === 'chat' ? host.trees?.find((t) => t.id === route.id)?.title : titles[route.name]
    document.title = title ? `${title} · GenseBot` : 'GenseBot'
  }, [route, host.trees])

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
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const hidden = phone || !sidebar
  const api = useMemo<ShellApi>(
    () => ({
      sidebarHidden: hidden,
      showSidebar: () => (phone ? setDrawer(true) : localPrefs.set((p) => ({ ...p, sidebar: true }))),
      openPalette: () => {
        setDrawer(false)
        setPalette(true)
      },
    }),
    [hidden, phone],
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
      <div className="flex h-dvh overflow-hidden">
        {!phone && (
          <aside className={cn('shrink-0 overflow-hidden border-r transition-[width] duration-200', sidebar ? 'w-68' : 'w-0 border-r-0')} inert={!sidebar}>
            <div className="h-full w-68">
              <Sidebar onNavigate={() => {}} onCollapse={() => localPrefs.set((p) => ({ ...p, sidebar: false }))} />
            </div>
          </aside>
        )}
        {phone && (
          <Drawer open={drawer} onOpenChange={setDrawer} label="侧边栏">
            <Sidebar onNavigate={() => setDrawer(false)} />
          </Drawer>
        )}
        <main className="relative flex min-w-0 flex-1 flex-col pt-[env(safe-area-inset-top)]">
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
      <header className="flex h-13 shrink-0 items-center px-2 md:px-3">
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
