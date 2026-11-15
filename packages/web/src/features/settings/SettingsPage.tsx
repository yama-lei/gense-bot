// Settings: how the assistant addresses the owner, model accounts, appearance, shortcuts, local data, usage and the
// owner's password. A section list on the left, one section on the right.
import type { LoginPrompt, ProviderState, ShareInfo } from '@gense/protocol'
import { sharePath } from '@gense/protocol'
import { Check, Cpu, Database, Download, ExternalLink, Gauge, Keyboard, Link2, LogOut, Monitor, Moon, Palette, ShieldCheck, Sun, UserRound } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { report, useClient, useHost, useMemories, useShares, useUser } from '../../app/client'
import { Page } from '../../app/Shell'
import { cn } from '../../lib/cn'
import { errorText, formatTime, saveBlob } from '../../lib/format'
import { modKey } from '../../lib/hooks'
import { lab, useLab } from '../../lib/lab'
import { Link, type SettingsSection } from '../../lib/router'
import type { LoginHandlers } from '../../lib/socket'
import { accentPref, accents, themePref, useAccent, useThemePref, type ThemePref } from '../../lib/theme'
import { Badge, PreviewBadge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { ConfirmDialog } from '../../ui/dialog'
import { Notice, Skeleton, Spinner } from '../../ui/feedback'
import { Field, Input, Textarea } from '../../ui/input'
import { Select } from '../../ui/select'
import { Switch } from '../../ui/switch'

const sections: { id: SettingsSection; label: string; icon: ReactNode }[] = [
  { id: 'personal', label: '个性化', icon: <UserRound /> },
  { id: 'models', label: '模型', icon: <Cpu /> },
  { id: 'appearance', label: '外观', icon: <Palette /> },
  { id: 'shortcuts', label: '快捷键', icon: <Keyboard /> },
  { id: 'data', label: '数据', icon: <Database /> },
  { id: 'plan', label: '用量', icon: <Gauge /> },
  { id: 'account', label: '账户', icon: <ShieldCheck /> },
]

const panels: Record<SettingsSection, () => ReactNode> = { personal: Personal, models: Models, appearance: Appearance, shortcuts: Shortcuts, data: Data, plan: Plan, account: Account }

export default function SettingsPage({ section = 'personal' }: { section?: SettingsSection }) {
  const Panel = panels[section]
  return (
    <Page title="设置" wide>
      <div className="flex flex-col gap-6 md:flex-row md:gap-10">
        <nav aria-label="设置" className="-mx-1 flex shrink-0 gap-0.5 overflow-x-auto px-1 md:sticky md:top-0 md:w-44 md:flex-col md:self-start md:overflow-visible">
          {sections.map((s) => (
            <Link
              key={s.id}
              to={{ name: 'settings', section: s.id }}
              replace
              aria-current={section === s.id ? 'page' : undefined}
              className={cn(
                'flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-3 text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground [&_svg]:size-4',
                section === s.id && 'bg-muted font-medium text-foreground hover:bg-muted',
              )}
            >
              {s.icon} {s.label}
            </Link>
          ))}
        </nav>
        <div key={section} className="min-w-0 flex-1 animate-rise">
          <Panel />
        </div>
      </div>
    </Page>
  )
}

function Section({ title, description, badge, children }: { title: string; description?: ReactNode; badge?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-10 last:mb-0">
      <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
        {title} {badge}
      </h2>
      {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  )
}

/** One setting: what it is on the left, its control on the right. */
function Row({ title, description, children }: { title: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        {description && <div className="mt-0.5 text-sm text-muted-foreground">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}
const rowsClass = 'flex flex-col divide-y overflow-hidden rounded-2xl border bg-card'

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
  const accent = useAccent()
  const { wide, suggestions } = useLab()
  return (
    <>
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
                pref === t.id ? 'border-accent bg-accent-soft font-medium text-accent' : 'text-muted-foreground hover:bg-hover',
              )}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      </Section>
      <Section title="强调色" description="按钮、链接和高亮使用的颜色。">
        <div role="radiogroup" aria-label="强调色" className="flex flex-wrap gap-2">
          {accents.map((a) => (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={accent === a.id}
              onClick={() => accentPref.set(a.id)}
              className={cn('flex h-9 items-center gap-2 rounded-full border pr-3.5 pl-2 text-sm transition-colors', accent === a.id ? 'border-foreground bg-card font-medium' : 'text-muted-foreground hover:bg-hover')}
            >
              <span className="grid size-5 place-items-center rounded-full text-white" style={{ background: a.swatch }}>
                {accent === a.id && <Check className="size-3" strokeWidth={3} />}
              </span>
              {a.label}
            </button>
          ))}
        </div>
      </Section>
      <Section title="对话">
        <div className={rowsClass}>
          <Row title="宽版布局" description="让对话区域占用更多横向空间，适合大屏幕和长代码。">
            <Switch checked={wide} onCheckedChange={(v) => lab.set((l) => ({ ...l, wide: v }))} aria-label="宽版布局" />
          </Row>
          <Row title="追问建议" description="在最新的回答下面给出几个可以继续问的方向。">
            <Switch checked={suggestions} onCheckedChange={(v) => lab.set((l) => ({ ...l, suggestions: v }))} aria-label="追问建议" />
          </Row>
        </div>
      </Section>
    </>
  )
}

// ── Shortcuts ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const shortcuts: { group: string; items: { label: string; keys: string[] }[] }[] = [
  {
    group: '全局',
    items: [
      { label: '搜索与命令', keys: [modKey, 'K'] },
      { label: '新对话', keys: [modKey, 'Shift', 'O'] },
      { label: '收起或展开侧栏', keys: [modKey, 'B'] },
      { label: '打开设置', keys: [modKey, ','] },
      { label: '查看快捷键', keys: [modKey, '/'] },
    ],
  },
  {
    group: '输入框',
    items: [
      { label: '换行', keys: ['Shift', 'Enter'] },
      { label: '发送（任何时候）', keys: [modKey, 'Enter'] },
      { label: '提及插件、Skill 或文件', keys: ['@'] },
      { label: '使用命令', keys: ['/'] },
      { label: '移除最后一个附件或提及', keys: ['Backspace'] },
    ],
  },
]

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex gap-1">
      {keys.map((k) => (
        <kbd key={k} className="grid h-6 min-w-6 place-items-center rounded-md border bg-muted px-1.5 font-sans text-xs text-muted-foreground">
          {k}
        </kbd>
      ))}
    </span>
  )
}

function Shortcuts() {
  const { sendKey } = useLab()
  return (
    <>
      <Section title="发送消息" description="选择按哪个键发送。另一个组合键用来换行。">
        <div role="radiogroup" aria-label="发送键" className="grid max-w-md grid-cols-2 gap-2">
          {(
            [
              { id: 'enter', keys: ['Enter'], help: 'Shift + Enter 换行' },
              { id: 'mod-enter', keys: [modKey, 'Enter'], help: 'Enter 换行' },
            ] as const
          ).map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={sendKey === o.id}
              onClick={() => lab.set((l) => ({ ...l, sendKey: o.id }))}
              className={cn('flex flex-col items-start gap-2 rounded-xl border p-3.5 text-left text-sm transition-colors', sendKey === o.id ? 'border-accent bg-accent-soft' : 'hover:bg-hover')}
            >
              <Keys keys={[...o.keys]} />
              <span className="text-muted-foreground">{o.help}</span>
            </button>
          ))}
        </div>
      </Section>
      {shortcuts.map((g) => (
        <Section key={g.group} title={g.group}>
          <ul className={rowsClass}>
            {g.items.map((i) => (
              <li key={i.label} className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
                {i.label} <Keys keys={i.keys} />
              </li>
            ))}
          </ul>
        </Section>
      ))}
    </>
  )
}

// ── Data ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Everything this browser keeps for the interface, by localStorage key. */
const localKeys = () => Object.keys(localStorage).filter((k) => k.startsWith('gense.'))

/** Every public link the user made, to open or stop (roadmap-7 B3). */
function Shares() {
  const client = useClient()
  const shares = useShares()
  const [stopping, setStopping] = useState<ShareInfo | null>(null)
  return (
    <Section title="公开链接" description="拿到链接的人无需登录就能看到对话的快照。新建或更新链接在对话的「分享」里。">
      {shares === null ? (
        <Skeleton className="h-14 rounded-2xl" />
      ) : shares.length === 0 ? (
        <p className="rounded-2xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">还没有公开分享过对话。临时对话不能分享。</p>
      ) : (
        <ul className={rowsClass}>
          {shares.map((sh) => (
            <li key={sh.token} className="flex items-center gap-3 px-4 py-3">
              <Link2 className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <Link to={{ name: 'chat', id: sh.treeId }} className="block truncate text-sm font-medium hover:underline">
                  {sh.title || '新对话'}
                </Link>
                <div className="text-xs text-muted-foreground">
                  {sh.turns} 轮 · 快照于 {formatTime(sh.updatedAt)}
                </div>
              </div>
              <Button size="sm" variant="ghost" asChild>
                <a href={sharePath(sh.token)} target="_blank" rel="noreferrer">
                  <ExternalLink /> 打开
                </a>
              </Button>
              <Button size="sm" variant="ghost-destructive" onClick={() => setStopping(sh)}>
                停止分享
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={!!stopping}
        onOpenChange={(v) => !v && setStopping(null)}
        title="停止分享？"
        confirm="停止分享"
        onConfirm={() => {
          if (stopping) client.deleteShare(stopping.token).catch(report)
        }}
      >
        「{stopping?.title || '新对话'}」的链接会立即失效，已经打开的人刷新后也看不到。对话本身不受影响。
      </ConfirmDialog>
    </Section>
  )
}

function Data() {
  const { prefs } = useHost()
  const client = useClient()
  const memories = useMemories()
  const [clearing, setClearing] = useState(false)

  const exportLocal = () => {
    const data = Object.fromEntries(localKeys().map((k) => [k, JSON.parse(localStorage.getItem(k) ?? 'null') as unknown]))
    saveBlob(`gense-local-${new Date().toISOString().slice(0, 10)}.json`, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  }

  return (
    <>
      <Section title="数据控制">
        <div className={rowsClass}>
          <Row title="在对话中参考记忆" description={<>记忆在「<Link to={{ name: 'memory' }} className="text-accent underline-offset-4 hover:underline">记忆</Link>」页管理，共 {memories?.length ?? 0} 条，网页和飞书里的对话都会参考。</>}>
            <Switch checked={prefs?.useMemory ?? true} disabled={!prefs} onCheckedChange={(v) => client.setPrefs({ useMemory: v })} aria-label="在对话中参考记忆" />
          </Row>
          <Row title={<span className="flex items-center gap-2">导出全部对话 <PreviewBadge /></span>} description="把所有对话和文件打包下载。现在可以在每个对话的「分享」里导出 Markdown。">
            <Button disabled>
              <Download /> 导出
            </Button>
          </Row>
        </div>
      </Section>
      <Shares />
      <Section title="这个浏览器里的数据" description="回答反馈、草稿和界面偏好保存在这个浏览器里，不会同步到其他设备。项目和记忆在你的账户里。">
        <div className={rowsClass}>
          <Row title="导出本地数据" description="下载为一个 JSON 文件。">
            <Button onClick={exportLocal}>
              <Download /> 导出
            </Button>
          </Row>
          <Row title="清除本地数据" description="删除反馈、草稿和界面偏好。对话、项目和记忆不受影响。">
            <Button variant="destructive" onClick={() => setClearing(true)}>
              清除
            </Button>
          </Row>
        </div>
      </Section>
      <ConfirmDialog
        open={clearing}
        onOpenChange={setClearing}
        title="清除这个浏览器里的数据？"
        confirm="清除并刷新"
        onConfirm={() => {
          for (const k of localKeys()) localStorage.removeItem(k)
          location.reload()
        }}
      >
        反馈、草稿和界面偏好都会删除，无法恢复。服务器上的对话、项目、记忆、文件和设置不受影响。
      </ConfirmDialog>
    </>
  )
}

// ── Plan ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

function Plan() {
  const { trees, schedules, models, providers } = useHost()
  const stats = [
    { label: '对话', value: trees?.length ?? '–' },
    { label: '定时任务', value: schedules.length },
    { label: '可用模型', value: models.length },
    { label: '模型账户', value: providers.filter((p) => p.configured).length },
  ]
  return (
    <>
      <Section title="当前方案">
        <div className="relative overflow-hidden rounded-2xl border bg-card p-5">
          <div aria-hidden className="aura pointer-events-none absolute inset-0 opacity-70" />
          <div className="relative flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-lg font-semibold tracking-tight">
                自托管 <Badge variant="accent">无限制</Badge>
              </div>
              <p className="mt-0.5 text-sm text-muted-foreground">Gense 运行在你自己的服务器上，用你自己的模型账户，没有消息条数限制。</p>
            </div>
            <Button asChild>
              <Link to={{ name: 'settings', section: 'models' }}>管理模型账户</Link>
            </Button>
          </div>
        </div>
      </Section>
      <Section title="概览">
        <dl className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label} className="rounded-2xl border bg-card p-4">
              <dt className="text-xs text-muted-foreground">{s.label}</dt>
              <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{s.value}</dd>
            </div>
          ))}
        </dl>
      </Section>
      <Section title="用量明细" badge={<PreviewBadge />} description="按模型和日期统计的 Token 用量与花费，以及每月预算提醒。">
        <div className="flex h-32 items-end gap-1.5 rounded-2xl border border-dashed p-4" aria-hidden>
          {[28, 44, 36, 62, 50, 78, 58, 40, 66, 84, 52, 70, 46, 60].map((h, i) => (
            <span key={i} className="flex-1 rounded-t-sm bg-accent/25" style={{ height: `${h}%` }} />
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">示意图，尚未连接真实数据。</p>
      </Section>
    </>
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
