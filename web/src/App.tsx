import { useEffect, useState } from 'react'
import { ChatView } from './components/ChatView'
import { CustomizeView, FilesView, HomeView, Loading, NotFound, ProjectView, ProjectsView, ScheduledView } from './components/Pages'
import { Sidebar } from './components/Sidebar'
import { SidebarContext } from './components/TopBar'
import { ModelsContext } from './models'
import { navigate, useRoute } from './router'
import { useStore } from './store'

const titles: Record<string, string> = { projects: '项目', files: '资料', scheduled: '定时任务', customize: '定制' }

export default function App() {
  const store = useStore()
  const route = useRoute()
  const [drawer, setDrawer] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const mobile = () => window.matchMedia('(max-width: 767px)').matches

  useEffect(() => setDrawer(false), [route])

  const conv = route.name === 'chat' ? store.state.conversations.find((c) => c.id === route.id) : undefined
  const project = route.name === 'project' ? store.state.projects.find((p) => p.id === route.id) : undefined
  const pageTitle = conv?.title ?? project?.name ?? titles[route.name]
  useEffect(() => {
    document.title = pageTitle ? `${pageTitle} · GenseBot` : 'GenseBot'
  }, [pageTitle])

  // Same shortcuts as ChatGPT: Ctrl/⌘+Shift+O new chat, Shift+Esc focus the input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        navigate({ name: 'home' })
      } else if (e.shiftKey && e.key === 'Escape') {
        e.preventDefault()
        document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toggle = () => (mobile() ? setDrawer((v) => !v) : setCollapsed((v) => !v))

  let view
  switch (route.name) {
    case 'home':
      view = <HomeView store={store} />
      break
    case 'chat': {
      const conv = store.state.conversations.find((c) => c.id === route.id)
      view = conv ? <ChatView key={conv.id} store={store} conv={conv} /> : store.ready ? <NotFound what="会话" /> : <Loading />
      break
    }
    case 'projects':
      view = <ProjectsView store={store} />
      break
    case 'project':
      view = <ProjectView store={store} id={route.id} />
      break
    case 'files':
      view = <FilesView store={store} tab={route.tab} id={route.id} quote={route.quote} />
      break
    case 'scheduled':
      view = <ScheduledView store={store} />
      break
    case 'customize':
      view = <CustomizeView store={store} />
      break
  }

  return (
    <ModelsContext.Provider value={store.state.models}>
      <SidebarContext.Provider value={{ toggle, open: drawer || !collapsed }}>
        <div className={'app' + (collapsed ? ' collapsed' : '')}>
          <Sidebar
            state={store.state}
            route={route}
            open={drawer}
            onClose={() => (mobile() ? setDrawer(false) : setCollapsed(true))}
            onReset={() => {
              store.reset()
              navigate({ name: 'home' })
            }}
          />
          <main className="main">{view}</main>
        </div>
        {store.bridge}
      </SidebarContext.Provider>
    </ModelsContext.Provider>
  )
}
