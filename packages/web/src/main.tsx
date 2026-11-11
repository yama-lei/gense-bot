import type { AccountResponse, UserInfo } from '@gense/protocol'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import './styles/app.css'
import { AppProvider } from './app/client'
import { Login } from './app/Login'
import { Shell } from './app/Shell'
import { api } from './lib/api'
import { useTheme } from './lib/theme'
import { TooltipProvider } from './ui/tooltip'

/** Shows the app once the session cookie checks out, the login page otherwise. */
function Root() {
  const [session, setSession] = useState<'checking' | 'out' | UserInfo>('checking')
  const theme = useTheme()
  useEffect(() => {
    if (session !== 'checking') return
    api<AccountResponse>('/api/me').then(
      (r) => setSession(r.user),
      () => setSession('out'),
    )
  }, [session])
  return (
    <TooltipProvider delayDuration={350} skipDelayDuration={200}>
      {session === 'out' && <Login onLogin={setSession} />}
      {typeof session === 'object' && (
        // Keyed by account, so signing in as someone else never shows the last one's state.
        <AppProvider key={session.id} user={session} onUnauthorized={() => setSession('out')}>
          <Shell />
        </AppProvider>
      )}
      <Toaster theme={theme} position="top-center" toastOptions={{ classNames: { toast: 'font-sans!' } }} />
    </TooltipProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
