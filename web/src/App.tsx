import { useEffect, useState } from 'react'
import { ChatView } from './components/ChatView'
import { CustomizeView, FilesView, HomeView, NotFound, ProjectView, ProjectsView, ScheduledView } from './components/Pages'
import { Sidebar } from './components/Sidebar'
import { SidebarContext } from './components/TopBar'
import { ModelsContext } from './models'
import { navigate, useRoute } from './router'
import { useStore } from './store'

export default function App() {
  const store = useStore()
  const route = useRoute()
  const [drawer, setDrawer] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const mobile = () => window.matchMedia('(max-width: 767px)').matches

  useEffect(() => setDrawer(false), [route])

  const toggle = () => (mobile() ? setDrawer((v) => !v) : setCollapsed((v) => !v))

  let view
  switch (route.name) {
    case 'home':
      view = <HomeView store={store} />
      break
    case 'chat': {
      const conv = store.state.conversations.find((c) => c.id === route.id)
      view = conv ? <ChatView key={conv.id} store={store} conv={conv} /> : <NotFound what="会话" />
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
