import { useState, type FormEvent } from 'react'

/** Email and password sign-in; accounts are created on the host with `npm run user:add`. */
export function Login({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
      if (res.ok) return onLogin()
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      setError(body.error ?? (res.status === 429 ? '尝试次数过多，请稍后再试' : '邮箱或密码不正确'))
    } catch {
      setError('无法连接服务器')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={(e) => void submit(e)}>
        <h1 className="brand">GenseBot</h1>
        <label className="field">
          邮箱
          <input type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          密码
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="small error-text">{error}</p>}
        <button className="btn primary" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  )
}
