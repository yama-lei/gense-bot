// Sign in or sign up by email (roadmap-6 D1). Sign-up shows only while the admin keeps registration open; the first
// account becomes the admin.
import type { AccountResponse, RegistrationState, UserInfo } from '@gense/protocol'
import { Blocks, Eye, EyeOff, FolderClosed, Timer, type LucideIcon } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../lib/api'
import { errorText } from '../lib/format'
import { Button } from '../ui/button'
import { Notice } from '../ui/feedback'
import { Field, Input } from '../ui/input'
import { Logo } from '../ui/logo'

const MIN_PASSWORD = 8

const pitch: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: Timer, title: '替你把事情做完', body: '定时任务、网页研究、写文档做图表——交代一次，结果送进收件箱。' },
  { icon: Blocks, title: '接上你的工具', body: '插件与 Skill 让它读邮件、查日历、连上飞书和你自己的服务。' },
  { icon: FolderClosed, title: '记得上下文', body: '项目、记忆和资料库，让每次对话都从上次停下的地方开始。' },
]

export function Login({ onLogin }: { onLogin: (user: UserInfo) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [open, setOpen] = useState<boolean | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [shown, setShown] = useState(false)
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
    <main className="grid min-h-dvh bg-sidebar lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:p-2.5">
      <section className="relative hidden flex-col justify-between overflow-hidden p-10 lg:flex">
        <div aria-hidden className="aura pointer-events-none absolute inset-0" />
        <div className="relative flex items-center gap-2 text-lg font-semibold tracking-tight">
          <Logo className="size-7" /> Gense
        </div>
        <div className="relative max-w-md">
          <h2 className="text-[2.1rem] leading-tight font-semibold tracking-tight">
            你的个人智能体，
            <br />
            <span className="text-accent">不只是聊天。</span>
          </h2>
          <ul className="mt-8 flex flex-col gap-5">
            {pitch.map((p) => (
              <li key={p.title} className="flex gap-3.5">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl border bg-card text-accent shadow-float">
                  <p.icon className="size-4.5" />
                </span>
                <span>
                  <span className="block text-sm font-medium">{p.title}</span>
                  <span className="text-sm text-muted-foreground">{p.body}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-muted-foreground">运行在你自己的服务器上，数据由你掌握。</p>
      </section>

      <section className="grid place-items-center bg-background px-5 py-10 lg:rounded-2xl lg:shadow-canvas">
        <form onSubmit={(e) => void submit(e)} className="flex w-full max-w-sm animate-rise flex-col gap-5">
          <div className="flex flex-col gap-2">
            <Logo className="size-10 lg:hidden" />
            <h1 className="text-2xl font-semibold tracking-tight">{register ? '创建账号' : '欢迎回来'}</h1>
            <p className="text-sm text-muted-foreground">{register ? '用邮箱注册，开始使用 Gense。' : '登录 Gense，继续上次的工作。'}</p>
          </div>
          <Field label="邮箱">
            <Input type="email" autoComplete="email" required autoFocus placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className="h-11" />
          </Field>
          <Field label="密码" help={register ? `至少 ${MIN_PASSWORD} 位` : undefined} error={short ? `密码至少 ${MIN_PASSWORD} 位` : null}>
            <div className="relative">
              <Input
                type={shown ? 'text' : 'password'}
                autoComplete={register ? 'new-password' : 'current-password'}
                required
                minLength={register ? MIN_PASSWORD : undefined}
                aria-invalid={short}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-11 pr-11"
              />
              <Button variant="ghost" size="icon-sm" aria-label={shown ? '隐藏密码' : '显示密码'} aria-pressed={shown} onClick={() => setShown(!shown)} className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground">
                {shown ? <EyeOff /> : <Eye />}
              </Button>
            </div>
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
          {!register && <p className="-mt-2 text-center text-xs text-muted-foreground">忘记密码？请联系管理员重设。</p>}
        </form>
      </section>
    </main>
  )
}
