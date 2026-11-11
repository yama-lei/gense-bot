import { useState, type FormEvent } from 'react'
import { Button } from '../ui/button'
import { Notice } from '../ui/feedback'
import { Field, Input } from '../ui/input'
import { Logo } from '../ui/logo'

/** The owner's password sign-in; the password is set on the server with `npm run passwd`. */
export function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) })
      if (res.ok) return onLogin()
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      setError(body.error ?? (res.status === 429 ? '尝试次数过多，请稍后再试' : '密码不正确'))
    } catch {
      setError('无法连接服务器')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center px-5 py-10">
      <form onSubmit={(e) => void submit(e)} className="flex w-full max-w-sm flex-col gap-5">
        <div className="flex flex-col items-center gap-3 text-center">
          <Logo className="size-11" />
          <h1 className="font-serif text-2xl">登录 GenseBot</h1>
        </div>
        <Field label="密码">
          <Input type="password" autoComplete="current-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} className="h-11" />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <Button type="submit" variant="primary" size="lg" disabled={busy || !password} className="h-11">
          {busy ? '登录中…' : '登录'}
        </Button>
        <p className="text-center text-xs text-muted-foreground">忘记密码时，在服务器上运行 npm run passwd 重设。</p>
      </form>
    </main>
  )
}
