// The admin's back office (roadmap-6 D7): accounts and the registration switch, the models shared with everyone, and
// what each account has spent. All of it goes over the HTTP admin API; the server checks the role on every call.
import type { RegistrationState, SharedProviderInfo, SharedProviderInput, UsageSummary, UserInfo, UserPatch } from '@gense/protocol'
import { KeyRound, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import { report, useUser } from '../../app/client'
import { Page } from '../../app/Shell'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'
import { errorText, hostOf } from '../../lib/format'
import { navigate, type AdminSection } from '../../lib/router'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter } from '../../ui/dialog'
import { Empty, Notice, Skeleton } from '../../ui/feedback'
import { Field, Input, Textarea } from '../../ui/input'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../ui/menu'
import { Select } from '../../ui/select'
import { Switch } from '../../ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs'

const sections: { id: AdminSection; label: string }[] = [
  { id: 'users', label: '用户' },
  { id: 'models', label: '共享模型' },
  { id: 'usage', label: '用量' },
]

export default function AdminPage({ section = 'users' }: { section?: AdminSection }) {
  return (
    <Page title="管理后台" description="只有管理员能看到这里。">
      <Tabs value={section} onValueChange={(v) => navigate({ name: 'admin', section: v as AdminSection }, { replace: true })}>
        <TabsList className="mb-6">
          {sections.map((s) => (
            <TabsTrigger key={s.id} value={s.id}>
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="users">
          <Registration />
          <Users />
        </TabsContent>
        <TabsContent value="models">
          <Providers />
        </TabsContent>
        <TabsContent value="usage">
          <Usage />
        </TabsContent>
      </Tabs>
    </Page>
  )
}

/** Loads `path` when it changes and on `reload()`; `data` stays until the next load succeeds. Null loads nothing. */
function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(
    async () =>
      path &&
      api<T>(path).then(
        (d) => {
          setData(d)
          setError(null)
        },
        (e) => setError(errorText(e)),
      ),
    [path],
  )
  useEffect(() => void reload(), [reload])
  return { data, error, reload, setData }
}

function Section({ title, description, actions, children }: { title: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-10 last:mb-0">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  )
}

// ── Users ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

function Registration() {
  const { data, error, setData } = useLoad<RegistrationState>('/api/admin/registration')
  const [busy, setBusy] = useState(false)
  const set = async (open: boolean) => {
    setBusy(true)
    try {
      setData(await api<RegistrationState>('/api/admin/registration', { method: 'PUT', body: { open } }))
    } catch (e) {
      report(e)
    }
    setBusy(false)
  }
  return (
    <div className="mb-8 flex items-center gap-4 rounded-2xl border bg-card p-4">
      <div className="min-w-0 flex-1">
        <label htmlFor="registration" className="font-medium">
          开放注册
        </label>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {error ?? (data?.open === false ? '登录页不显示注册入口，新注册会被拒绝。' : '任何能打开这个网址的人都能注册，并使用共享模型。')}
        </p>
      </div>
      <Switch id="registration" checked={!!data?.open} disabled={!data || busy} onCheckedChange={(open) => void set(open)} />
    </div>
  )
}

function Users() {
  const me = useUser()
  const { data: users, error, reload } = useLoad<UserInfo[]>('/api/admin/users')
  const [disabling, setDisabling] = useState<UserInfo | null>(null)

  const patch = async (u: UserInfo, change: UserPatch, done: string) => {
    try {
      await api<UserInfo>(`/api/admin/users/${encodeURIComponent(u.id)}`, { method: 'PATCH', body: change })
      toast.success(done)
    } catch (e) {
      report(e)
    }
    void reload()
  }

  return (
    <Section title="用户" description={users ? `${users.length} 个账号` : undefined}>
      {error && <Notice tone="error">{error}</Notice>}
      {!users && !error && <Skeleton className="h-40 rounded-2xl" />}
      {users && (
        <ul className="divide-y overflow-hidden rounded-2xl border bg-card">
          {users.map((u) => {
            const self = u.id === me.id
            return (
              <li key={u.id} className={cn('flex items-center gap-3 px-4 py-3', u.disabled && 'text-muted-foreground')}>
                <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent uppercase">
                  {[...u.email][0]}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="min-w-0 truncate font-medium" title={u.email}>
                      {u.email}
                    </span>
                    {self && <Badge variant="outline">你</Badge>}
                    {u.role === 'admin' && <Badge variant="accent">管理员</Badge>}
                    {u.disabled && <Badge variant="destructive">已停用</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">注册于 {new Date(u.createdAt).toLocaleDateString()}</p>
                </div>
                {/* Your own account is changed by another admin, so you cannot lock yourself out from here. */}
                {!self && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`${u.email} 的操作`}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {u.role === 'admin' ? (
                        <DropdownMenuItem onSelect={() => void patch(u, { role: 'user' }, '已取消管理员')}>取消管理员</DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem onSelect={() => void patch(u, { role: 'admin' }, '已设为管理员')}>设为管理员</DropdownMenuItem>
                      )}
                      {u.disabled ? (
                        <DropdownMenuItem onSelect={() => void patch(u, { disabled: false }, '已启用')}>启用</DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem destructive onSelect={() => setDisabling(u)}>
                          停用
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <ConfirmDialog
        open={!!disabling}
        onOpenChange={(v) => !v && setDisabling(null)}
        title={`停用 ${disabling?.email ?? ''}？`}
        confirm="停用"
        onConfirm={() => disabling && void patch(disabling, { disabled: true }, '已停用')}
      >
        对方会立即退出登录，飞书机器人和定时任务也会停下。数据保留，启用后恢复。
      </ConfirmDialog>
    </Section>
  )
}

// ── Shared models ──────────────────────────────────────────────────────────────────────────────────────────────────────

function Providers() {
  const { data: providers, error, reload } = useLoad<SharedProviderInfo[]>('/api/admin/providers')
  const [editing, setEditing] = useState<SharedProviderInfo | 'new' | null>(null)
  const [deleting, setDeleting] = useState<SharedProviderInfo | null>(null)

  const remove = async (p: SharedProviderInfo) => {
    try {
      await api(`/api/admin/providers/${encodeURIComponent(p.id)}`, { method: 'DELETE' })
      toast.success(`已删除 ${p.name}`)
    } catch (e) {
      report(e)
    }
    void reload()
  }

  return (
    <Section
      title="共享模型"
      description="这里登记的模型服务对所有用户可用，在模型菜单里标为“共享”。密钥加密保存，任何人（包括管理员）都看不到。"
      actions={
        <Button variant="primary" onClick={() => setEditing('new')}>
          <Plus /> 添加
        </Button>
      }
    >
      {error && <Notice tone="error">{error}</Notice>}
      {!providers && !error && <Skeleton className="h-32 rounded-2xl" />}
      {providers?.length === 0 && (
        <Empty icon={<KeyRound />} title="还没有共享模型">
          添加一个兼容 OpenAI Responses 接口的服务，所有用户就能直接用它的模型。
        </Empty>
      )}
      {!!providers?.length && (
        <ul className="flex flex-col gap-3">
          {providers.map((p) => (
            <li key={p.id} className="rounded-2xl border bg-card p-4">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{p.name}</span>
                    {!p.hasKey && <Badge variant="warning">缺少密钥</Badge>}
                  </div>
                  <p className="mt-0.5 truncate text-sm text-muted-foreground" title={p.baseUrl}>
                    {hostOf(p.baseUrl)}
                  </p>
                </div>
                <Button variant="ghost" size="icon-sm" aria-label={`编辑 ${p.name}`} onClick={() => setEditing(p)}>
                  <Pencil />
                </Button>
                <Button variant="ghost-destructive" size="icon-sm" aria-label={`删除 ${p.name}`} onClick={() => setDeleting(p)}>
                  <Trash2 />
                </Button>
              </div>
              <ul className="mt-3 flex flex-wrap gap-1.5">
                {p.modelIds.map((m, i) => (
                  <li key={m}>
                    <Badge variant="outline">
                      {m}
                      {i === 0 && <span className="font-normal opacity-75">· 默认</span>}
                    </Badge>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {editing && <ProviderDialog provider={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => void reload()} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title={`删除 ${deleting?.name ?? ''}？`}
        confirm="删除"
        onConfirm={() => deleting && void remove(deleting)}
      >
        所有用户的模型菜单里都不再有它的模型。已有的用量记录保留。
      </ConfirmDialog>
    </Section>
  )
}

const splitIds = (text: string) => [...new Set(text.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean))]

function ProviderDialog({ provider, onClose, onSaved }: { provider: SharedProviderInfo | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(provider?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '')
  const [ids, setIds] = useState(provider?.modelIds.join('\n') ?? '')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const modelIds = splitIds(ids)
  const ready = !!name.trim() && !!baseUrl.trim() && modelIds.length > 0 && (!!provider || !!apiKey.trim())

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const body: SharedProviderInput = { name: name.trim(), baseUrl: baseUrl.trim(), modelIds, ...(apiKey.trim() && { apiKey: apiKey.trim() }) }
    try {
      await api<SharedProviderInfo>(provider ? `/api/admin/providers/${encodeURIComponent(provider.id)}` : '/api/admin/providers', { method: provider ? 'PUT' : 'POST', body })
      toast.success(provider ? '已保存' : `已添加 ${body.name}`)
      onSaved()
      onClose()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent title={provider ? `编辑 ${provider.name}` : '添加共享模型'} description="兼容 OpenAI Responses 接口的服务。">
        <form onSubmit={(e) => void save(e)} className="flex min-h-0 flex-1 flex-col">
          <DialogBody className="flex flex-col gap-4">
            <Field label="名称" help="模型菜单里的分组名。">
              <Input required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：公司中转" />
            </Field>
            <Field label="接口地址">
              <Input type="url" required value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://example.com/v1" />
            </Field>
            <Field label="模型" help="每行一个模型 ID，第一个是默认模型。">
              <Textarea required rows={4} value={ids} onChange={(e) => setIds(e.target.value)} className="font-mono text-sm" />
            </Field>
            <Field label="密钥" help={provider ? (provider.hasKey ? '留空则保留现在的密钥。' : '还没有密钥，请填写。') : undefined}>
              <Input type="password" autoComplete="off" required={!provider} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={provider?.hasKey ? '••••••••' : undefined} />
            </Field>
            {error && <Notice tone="error">{error}</Notice>}
          </DialogBody>
          <DialogFooter>
            <Button onClick={onClose}>取消</Button>
            <Button type="submit" variant="primary" disabled={busy || !ready}>
              {busy ? '保存中…' : provider ? '保存' : '添加'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── Usage ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const utcDay = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })
const full = new Intl.NumberFormat('zh-CN')

type GroupBy = 'user' | 'day' | 'model'
const groupOptions = [
  { value: 'user', label: '按用户' },
  { value: 'day', label: '按天' },
  { value: 'model', label: '按模型' },
]
type Totals = Pick<UsageSummary, 'calls' | 'input' | 'output' | 'cacheRead' | 'totalTokens'>
const columns: { key: keyof Totals; label: string }[] = [
  { key: 'calls', label: '调用' },
  { key: 'input', label: '输入' },
  { key: 'output', label: '输出' },
  { key: 'cacheRead', label: '缓存读取' },
  { key: 'totalTokens', label: '合计' },
]
const zero = (): Totals => ({ calls: 0, input: 0, output: 0, cacheRead: 0, totalTokens: 0 })
const add = (t: Totals, r: Totals) => {
  for (const c of columns) t[c.key] += r[c.key]
  return t
}

function Usage() {
  const [from, setFrom] = useState(utcDay(-6))
  const [to, setTo] = useState(utcDay())
  const [by, setBy] = useState<GroupBy>('user')
  const valid = !!from && !!to && from <= to
  const { data, error } = useLoad<UsageSummary[]>(valid ? `/api/admin/usage?from=${from}&to=${to}` : null)

  const rows = useMemo(() => {
    const groups = new Map<string, { label: string; source?: UsageSummary['source']; totals: Totals }>()
    for (const r of data ?? []) {
      const key = by === 'user' ? r.userId : by === 'day' ? r.day : `${r.source}:${r.provider}:${r.model}`
      const label = by === 'user' ? r.email : by === 'day' ? r.day : r.model
      const g = groups.get(key) ?? { label, ...(by === 'model' && { source: r.source }), totals: zero() }
      add(g.totals, r)
      groups.set(key, g)
    }
    const list = [...groups.values()]
    return by === 'day' ? list.sort((a, b) => b.label.localeCompare(a.label)) : list.sort((a, b) => b.totals.totalTokens - a.totals.totalTokens)
  }, [data, by])
  const total = useMemo(() => rows.reduce((t, r) => add(t, r.totals), zero()), [rows])

  return (
    <Section title="用量" description="每次模型调用的 token，按 UTC 日期统计；包括自带账户的调用。">
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="从" className="w-40">
          <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="到" className="w-40">
          <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </Field>
        {/* Not a Field: a label around the select's button would open it twice. */}
        <div className="flex w-32 flex-col gap-1.5 text-sm">
          <span className="font-medium">分组</span>
          <Select label="分组" value={by} onChange={(v) => setBy(v as GroupBy)} options={groupOptions} />
        </div>
      </div>
      {!valid ? (
        <Notice tone="warning">开始日期不能晚于结束日期。</Notice>
      ) : error ? (
        <Notice tone="error">{error}</Notice>
      ) : !data ? (
        <Skeleton className="h-40 rounded-2xl" />
      ) : rows.length === 0 ? (
        <Empty title="这段时间没有调用" className="py-10" />
      ) : (
        <div className="overflow-x-auto rounded-2xl border bg-card">
          <table className="w-full min-w-[34rem] text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="px-4 py-2.5 font-medium">{groupOptions.find((g) => g.value === by)!.label.slice(1)}</th>
                {columns.map((c) => (
                  <th key={c.key} className="px-3 py-2.5 text-right font-medium">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => (
                <tr key={`${r.label}:${r.source ?? ''}`}>
                  <td className="max-w-56 px-4 py-2.5">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate" title={r.label}>
                        {r.label}
                      </span>
                      {r.source && <Badge variant={r.source === 'shared' ? 'neutral' : 'accent'}>{r.source === 'shared' ? '共享' : '自带'}</Badge>}
                    </div>
                  </td>
                  {columns.map((c) => (
                    <Cell key={c.key} n={r.totals[c.key]} strong={c.key === 'totalTokens'} />
                  ))}
                </tr>
              ))}
            </tbody>
            {rows.length > 1 && (
              <tfoot className="border-t font-medium">
                <tr>
                  <td className="px-4 py-2.5">合计</td>
                  {columns.map((c) => (
                    <Cell key={c.key} n={total[c.key]} strong />
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </Section>
  )
}

function Cell({ n, strong }: { n: number; strong?: boolean }) {
  return (
    <td className={cn('px-3 py-2.5 text-right tabular-nums', !strong && 'text-muted-foreground')} title={full.format(n)}>
      {compact.format(n)}
    </td>
  )
}
