import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import App from './App.tsx'
import { Login } from './components/Login.tsx'

/** Shows the app once the session cookie checks out, the login page otherwise. */
function Root() {
  const [session, setSession] = useState<'checking' | 'in' | 'out'>('checking')
  useEffect(() => {
    if (session !== 'checking') return
    fetch('/api/me').then(
      (r) => setSession(r.ok ? 'in' : 'out'),
      () => setSession('out'),
    )
  }, [session])
  if (session === 'checking') return null
  if (session === 'out') return <Login onLogin={() => setSession('in')} />
  return <App onUnauthorized={() => setSession('out')} />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
