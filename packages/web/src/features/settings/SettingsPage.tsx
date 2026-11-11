// Settings: how the assistant addresses the owner, model accounts, appearance, and the owner's password.
import type { LoginPrompt, ProviderState } from '@gense/protocol'
import { ExternalLink, LogOut, Monitor, Moon, Sun } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { report, useClient, useHost, useUser } from '../../app/client'
import { Page } from '../../app/Shell'
import { cn } from '../../lib/cn'
import { errorText } from '../../lib/format'
import { navigate, type SettingsSection } from '../../lib/router'
import type { LoginHandlers } from '../../lib/socket'
import { themePref, useThemePref, type ThemePref } from '../../lib/theme'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Notice, Skeleton, Spinner } from '../../ui/feedback'
import { Field, Input, Textarea } from '../../ui/input'
import { Select } from '../../ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs'

const sections: { id: SettingsSection; label: string }[] = [
  { id: 'personal', label: '个性化' },
  { id: 'models', label: '模型' },
  { id: 'appearance', label: '外观' },
  { id: 'account', label: '账户' },
]

export default function SettingsPage({ section = 'personal' }: { section?: SettingsSection }) {
  return (
    <Page title="设置">
      <Tabs value={section} onValueChange={(v) => navigate({ name: 'settings', section: v as SettingsSection }, { replace: true })}>
        <TabsList className="mb-6">
          {sections.map((s) => (
            <TabsTrigger key={s.id} value={s.id}>
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="personal">
          <Personal />
        </TabsContent>
        <TabsContent value="models">
          <Models />
        </TabsContent>
        <TabsContent value="appearance">
          <Appearance />
        </TabsContent>
        <TabsContent value="account">
          <Account />
        </TabsContent>
      </Tabs>
    </Page>
  )
}

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-10 last:mb-0">
      <h2 className="text-base font-semibold">{title}</h2>
      {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  )
}

// ── Personal ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function Personal() {
  const { prefs } = useHost()
  if (!prefs) return <Skeleton className="h-64 rounded-2xl" />
  // Keyed so another device's change replaces an untouched form.
  return <PersonalForm key={`${prefs.name}\n${prefs.instructions}`} name={prefs.name} instructions={prefs.instructions} />
}

function PersonalForm(saved: { name: string; instructions: string }) {
  const client = useClient()
  const [name, setName] = useState(saved.name)
  const [instructions, setInstructions] = useState(saved.instructions)
  const [busy, setBusy] = useState(false)
  const dirty = name.trim() !== saved.name || instructions.trim() !== saved.instructions
  return (
    <Section title="个性化" description="助手在每个对话里都会看到这些，包括飞书里的对话。">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          setBusy(true)
          client
            .request({ t: 'prefs.set', name: name.trim(), instructions: instructions.trim() })
            .then(() => toast.success('已保存'), report)
            .finally(() => setBusy(false))
        }}
      >
        <Field label="怎么称呼你">
          <Input value={name} maxLength={60} placeholder="你的名字或昵称" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="自定义指令" help="例如你的职业、偏好的回答风格、常用的语言和工具。">
          <Textarea rows={8} value={instructions} maxLength={8000} placeholder="回答尽量简洁；代码示例用 TypeScript……" onChange={(e) => setInstructions(e.target.value)} />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={busy || !dirty}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </div>
      </form>
    </Section>
  )
}

// ── Models ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

type AuthEvent = Parameters<LoginHandlers['event']>[0]
type AuthType = NonNullable<ProviderState['configured']>

/** A login the server is running: what it has said so far and the questions it waits on. */
interface Run {
  provider: string
  name: string
  events: AuthEvent[]
  prompts: { id: string; prompt: LoginPrompt }[]
  cancel: () => void
}

function Models() {
  const client = useClient()
  const { providers, models } = useHost()
  const signedIn = providers.filter((p) => p.configured)
  const [picked, setPicked] = useState('')
  const [run, setRun] = useState<Run | null>(null)
  const [error, setError] = useState<string | null>(null)
  const current = providers.find((p) => p.id === picked)
  const running = useRef<Run | null>(null)
  // Leaving the page ends a login that still waits on the user.
  useEffect(() => () => running.current?.cancel(), [])

  const start = (type: AuthType) => {
    if (!current) return
    setError(null)
    const update = (fn: (r: Run) => Run) => setRun((r) => (r && r.provider === current.id ? fn(r) : r))
    const login = client.socket.login(current.id, type, {
      event: (e) => update((r) => ({ ...r, events: [...r.events, e] })),
      prompt: (id, prompt) => update((r) => ({ ...r, prompts: [...r.prompts, { id, prompt }] })),
      promptDone: (id) => update((r) => ({ ...r, prompts: r.prompts.filter((p) => p.id !== id) })),
    })
    const next: Run = { provider: current.id, name: current.name, events: [], prompts: [], cancel: login.cancel }
    running.current = next
    setRun(next)
    login.done
      .then(
        () => {
          setPicked('')
          toast.success(`已登录 ${next.name}`)
        },
        (e: unknown) => setError(errorText(e)),
      )
      .finally(() => {
        if (running.current === next) running.current = null
        setRun((r) => (r === null || r.provider === next.provider ? null : r))
      })
  }

  return (
    <>
      <Section title="模型账户" description="用 API Key 或订阅账号登录模型服务，它的模型会出现在输入框的模型菜单里。凭据加密保存在服务器上，只有你能用。">
        {signedIn.length > 0 && (
          <ul className="mb-4 divide-y overflow-hidden rounded-2xl border bg-card">
            {signedIn.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{p.name}</span>
                    <Badge variant="outline">{p.configured === 'oauth' ? '订阅' : 'API Key'}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{models.filter((m) => m.provider === p.id).length} 个模型</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => void client.request({ t: 'auth.logout', provider: p.id }).catch(report)}>
                  退出
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
          <Field label="添加模型服务">
            <Select
              label="模型服务"
              value={picked}
              placeholder="选择一个模型服务…"
              disabled={!!run}
              options={providers.map((p) => ({ value: p.id, label: p.name, ...(p.configured && { description: '已登录' }) }))}
              onChange={(v) => {
                setPicked(v)
                setError(null)
              }}
            />
          </Field>
          {current && !run && (
            <div className="flex flex-wrap gap-2">
              {current.apiKey && <Button onClick={() => start('api_key')}>用 API Key 登录</Button>}
              {current.oauth && (
                <Button title={current.oauth} onClick={() => start('oauth')}>
                  用订阅账号登录
                </Button>
              )}
              {!current.apiKey && !current.oauth && <p className="text-sm text-muted-foreground">这台服务器不能登录这个服务。</p>}
            </div>
          )}
          {run && <LoginPanel run={run} onError={setError} />}
          {error && <Notice tone="error">{error}</Notice>}
        </div>
      </Section>
      <Section title="可用模型" description="“共享”的模型由管理员提供，“自带”的用你自己的账户。默认模型在输入框的模型菜单里选择，按浏览器记住。">
        {models.length === 0 ? (
          <Notice tone="warning">还没有可用的模型。登录一个模型服务，或请管理员共享模型。</Notice>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {models.map((m) => (
              <li key={`${m.provider}:${m.id}`}>
                <Badge variant={m.source === 'byok' ? 'accent' : 'outline'} title={m.providerName ?? m.provider}>
                  {m.name}
                  {m.source && <span className="font-normal opacity-75">· {m.source === 'shared' ? '共享' : '自带'}</span>}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  )
}

const linkClass = 'inline-flex items-center gap-1 text-accent underline-offset-2 hover:underline'

function LoginPanel({ run, onError }: { run: Run; onError: (e: string) => void }) {
  const client = useClient()
  const progress = run.events.findLast((e) => e.type === 'progress')
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-muted p-3.5 text-sm" aria-live="polite">
      <div className="flex items-center gap-2 font-medium">
        <Spinner /> 正在登录 {run.name}
      </div>
      {run.events.map((e, i) => {
        switch (e.type) {
          case 'info':
            return (
              <p key={i}>
                {e.message}
                {e.links?.map((l) => (
                  <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className={cn(linkClass, 'ml-1.5')}>
                    {l.label ?? l.url}
                  </a>
                ))}
              </p>
            )
          case 'auth_url':
            return (
              <p key={i}>
                {e.instructions ?? '在新窗口中完成授权：'}{' '}
                <a href={e.url} target="_blank" rel="noreferrer" className={linkClass}>
                  打开授权页面 <ExternalLink className="size-3.5" />
                </a>
              </p>
            )
          case 'device_code':
            return (
              <p key={i}>
                打开{' '}
                <a href={e.verificationUri} target="_blank" rel="noreferrer" className={linkClass}>
                  {e.verificationUri}
                </a>{' '}
                并输入代码 <code className="rounded-md bg-background px-1.5 py-0.5 font-mono font-semibold tracking-wider">{e.userCode}</code>
              </p>
            )
          default:
            return null
        }
      })}
      {progress && <p className="text-muted-foreground">{progress.message}</p>}
      {run.prompts.map((p) => (
        <PromptForm key={p.id} prompt={p.prompt} onAnswer={(value) => void client.request({ t: 'auth.answer', promptId: p.id, value }).catch((e: unknown) => onError(errorText(e)))} />
      ))}
      <Button className="self-start" size="sm" onClick={run.cancel}>
        取消登录
      </Button>
    </div>
  )
}

function PromptForm({ prompt, onAnswer }: { prompt: LoginPrompt; onAnswer: (value: string) => void }) {
  const [value, setValue] = useState(prompt.type === 'select' ? (prompt.options[0]?.id ?? '') : '')
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        if (value.trim()) onAnswer(prompt.type === 'select' ? value : value.trim())
      }}
    >
      <span className="font-medium">{prompt.message}</span>
      <div className="flex gap-2">
        {prompt.type === 'select' ? (
          <Select
            label={prompt.message}
            value={value}
            className="flex-1"
            options={prompt.options.map((o) => ({ value: o.id, label: o.label, ...(o.description && { description: o.description }) }))}
            onChange={setValue}
          />
        ) : (
          <Input
            type={prompt.type === 'secret' ? 'password' : 'text'}
            autoComplete="off"
            autoFocus
            aria-label={prompt.message}
            placeholder={prompt.placeholder ?? ''}
            value={value}
            className="flex-1 bg-background"
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        <Button type="submit" variant="primary" disabled={!value.trim()}>
          确定
        </Button>
      </div>
    </form>
  )
}

// ── Appearance ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const themes: { id: ThemePref; label: string; icon: ReactNode }[] = [
  { id: 'system', label: '跟随系统', icon: <Monitor /> },
  { id: 'light', label: '浅色', icon: <Sun /> },
  { id: 'dark', label: '深色', icon: <Moon /> },
]

function Appearance() {
  const pref = useThemePref()
  return (
    <Section title="主题" description="只对这个浏览器生效。">
      <div role="radiogroup" aria-label="主题" className="grid max-w-md grid-cols-3 gap-2">
        {themes.map((t) => (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={pref === t.id}
            onClick={() => themePref.set(t.id)}
            className={cn(
              'flex flex-col items-center gap-2 rounded-xl border px-3 py-4 text-sm transition-colors [&_svg]:size-5',
              pref === t.id ? 'border-foreground bg-card font-medium' : 'text-muted-foreground hover:bg-hover',
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>
    </Section>
  )
}

// ── Account ────────────────────────────────────────────────────────────────────────────────────────────────────────────

function Account() {
  const client = useClient()
  const user = useUser()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mismatch = !!again && next !== again

  const change = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ current, next }) })
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `修改失败（${res.status}）`)
      setCurrent('')
      setNext('')
      setAgain('')
      toast.success('密码已修改，其他设备已退出登录')
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }

  return (
    <>
      <Section title="账号">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium break-all">{user.email}</span>
          {user.role === 'admin' && <Badge variant="accent">管理员</Badge>}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">注册于 {new Date(user.createdAt).toLocaleDateString()}</p>
      </Section>
      <Section title="修改密码" description="修改后，其他浏览器和设备上的登录都会失效。">
        <form
          className="flex max-w-sm flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            void change()
          }}
        >
          <Field label="当前密码">
            <Input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="新密码">
            <Input type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field label="再输入一次新密码" error={mismatch ? '两次输入不一致' : null}>
            <Input type="password" autoComplete="new-password" required aria-invalid={mismatch} value={again} onChange={(e) => setAgain(e.target.value)} />
          </Field>
          {error && <Notice tone="error">{error}</Notice>}
          <Button type="submit" variant="primary" className="self-start" disabled={busy || !current || !next || next !== again}>
            {busy ? '修改中…' : '修改密码'}
          </Button>
        </form>
      </Section>
      <Section title="退出登录" description="只退出这个浏览器。">
        <Button onClick={() => void client.logout()}>
          <LogOut /> 退出登录
        </Button>
      </Section>
    </>
  )
}
