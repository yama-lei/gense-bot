// Sign in or sign up by email (roadmap-6 D1). Sign-up shows only while the admin keeps registration open; the first
// account becomes the admin.
import type { AccountResponse, RegistrationState, UserInfo } from '@gense/protocol'
import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../lib/api'
import { errorText } from '../lib/format'
import { Button } from '../ui/button'
import { Notice } from '../ui/feedback'
import { Field, Input } from '../ui/input'
import { Logo } from '../ui/logo'

const MIN_PASSWORD = 8

export function Login({ onLogin }: { onLogin: (user: UserInfo) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [open, setOpen] = useState<boolean | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const register = mode === 'register'
  const short = register && !!password && password.length < MIN_PASSWORD

  useEffect(() => {
    api<RegistrationState>('/api/registration').then(
      (r) => setOpen(r.open),
      () => setOpen(false),
    )
  }, [])

  const switchTo = (next: typeof mode) => {
    setMode(next)
    setError(null)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { user } = await api<AccountResponse>(register ? '/api/register' : '/api/login', { body: { email: email.trim(), password } })
      onLogin(user)
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center px-5 py-10">
      <form onSubmit={(e) => void submit(e)} className="flex w-full max-w-sm flex-col gap-5">
        <div className="flex flex-col items-center gap-3 text-center">
          <Logo className="size-11" />
          <h1 className="font-serif text-2xl">{register ? '注册 GenseBot' : '登录 GenseBot'}</h1>
        </div>
        <Field label="邮箱">
          <Input type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} className="h-11" />
        </Field>
        <Field label="密码" help={register ? `至少 ${MIN_PASSWORD} 位` : undefined} error={short ? `密码至少 ${MIN_PASSWORD} 位` : null}>
          <Input
            type="password"
            autoComplete={register ? 'new-password' : 'current-password'}
            required
            minLength={register ? MIN_PASSWORD : undefined}
            aria-invalid={short}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-11"
          />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <Button type="submit" variant="primary" size="lg" disabled={busy || !email.trim() || !password || short} className="h-11">
          {register ? (busy ? '注册中…' : '注册') : busy ? '登录中…' : '登录'}
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          {register ? (
            <>
              已有账号？
              <button type="button" className="font-medium text-foreground underline-offset-4 hover:underline" onClick={() => switchTo('login')}>
                登录
              </button>
            </>
          ) : open ? (
            <>
              还没有账号？
              <button type="button" className="font-medium text-foreground underline-offset-4 hover:underline" onClick={() => switchTo('register')}>
                注册
              </button>
            </>
          ) : open === false ? (
            '暂不开放注册。需要账号请联系管理员。'
          ) : null}
        </p>
        {!register && <p className="-mt-2 text-center text-xs text-muted-foreground">忘记密码时，请管理员在服务器上运行 npm run passwd 加你的邮箱重设。</p>}
      </form>
    </main>
  )
}
