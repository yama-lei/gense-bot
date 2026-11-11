// Plugins (built-in tools and MCP servers) and Skills (Agent Skills folders): what the assistant can use.
import type { FilePreview, McpStatus, PluginInfo, SkillInfo, SkillSource } from '@gense/protocol'
import { BookOpen, FileText, KeyRound, Pencil, Plug, Plus, Puzzle, RefreshCw, Trash2, Upload, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MAX_UPLOAD, report, useClient, useHost } from '../../app/client'
import { Page } from '../../app/Shell'
import { cn } from '../../lib/cn'
import { errorText } from '../../lib/format'
import { navigate } from '../../lib/router'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter } from '../../ui/dialog'
import { Empty, Notice, Skeleton, Spinner } from '../../ui/feedback'
import { Field, Input } from '../../ui/input'
import { Switch } from '../../ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs'
import { Markdown } from '../chat/Markdown'
import { SettingsForm } from './SettingsForm'

const mcpStatus: Record<McpStatus, { label: string; variant: 'neutral' | 'accent' | 'success' | 'warning' | 'destructive' }> = {
  connecting: { label: '连接中', variant: 'accent' },
  ready: { label: '已连接', variant: 'success' },
  auth: { label: '需要登录', variant: 'warning' },
  error: { label: '连接失败', variant: 'destructive' },
  off: { label: '未启用', variant: 'neutral' },
}

const card = 'divide-y overflow-hidden rounded-2xl border bg-card'

function SectionHead({ title, description, action }: { title: string; description: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  )
}

export default function PluginsPage({ tab }: { tab: 'plugins' | 'skills' }) {
  return (
    <Page title="插件与 Skill" description="插件给助手工具，Skill 教它怎么完成一类任务。">
      <Tabs value={tab} onValueChange={(v) => navigate(v === 'skills' ? { name: 'plugins', tab: 'skills' } : { name: 'plugins' }, { replace: true })}>
        <TabsList className="mb-6">
          <TabsTrigger value="plugins">
            <Puzzle className="size-4" /> 插件
          </TabsTrigger>
          <TabsTrigger value="skills">
            <BookOpen className="size-4" /> Skills
          </TabsTrigger>
        </TabsList>
        <TabsContent value="plugins">
          <PluginsTab />
        </TabsContent>
        <TabsContent value="skills">
          <SkillsTab />
        </TabsContent>
      </Tabs>
    </Page>
  )
}

// ── Plugins ────────────────────────────────────────────────────────────────────────────────────────────────────────────

function PluginsTab() {
  const { plugins } = useHost()
  const [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  if (!plugins)
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-16 rounded-2xl" />
        <Skeleton className="h-16 rounded-2xl" />
        <Skeleton className="h-16 rounded-2xl" />
      </div>
    )
  const builtin = plugins.filter((p) => p.kind === 'builtin')
  const mcp = plugins.filter((p) => p.kind === 'mcp')
  const open = plugins.find((p) => p.id === openId)
  return (
    <>
      <section className="mb-10">
        <SectionHead
          title="MCP 服务器"
          description="连接任何支持 Streamable HTTP 的 MCP 服务器；它的工具和界面（MCP Apps）会出现在对话里。"
          action={
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Plus /> 添加
            </Button>
          }
        />
        {mcp.length === 0 ? (
          <Empty icon={<Plug />} title="还没有 MCP 服务器">
            填一个服务器地址就能接入，例如团队内部工具或第三方服务提供的 MCP 端点。
          </Empty>
        ) : (
          <ul className={card}>
            {mcp.map((p) => (
              <PluginRow key={p.id} plugin={p} onOpen={() => setOpenId(p.id)} />
            ))}
          </ul>
        )}
      </section>
      <section>
        <SectionHead title="内置插件" description="关闭后，助手不能调用它的工具。" />
        <ul className={card}>
          {builtin.map((p) => (
            <PluginRow key={p.id} plugin={p} onOpen={() => setOpenId(p.id)} />
          ))}
        </ul>
      </section>

      <Dialog open={!!open} onOpenChange={(v) => !v && setOpenId(null)}>
        {open && (
          <DialogContent title={open.name} description={open.description} className="sm:max-w-xl">
            <PluginDetail key={open.id} plugin={open} onRemoved={() => setOpenId(null)} />
          </DialogContent>
        )}
      </Dialog>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent title="添加 MCP 服务器" description="服务器地址和请求头保存在服务器上；请求头的值不会再显示。">
          {adding && (
            <McpForm
              onDone={(added) => {
                setAdding(false)
                if (added) setOpenId(added.id)
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function PluginRow({ plugin: p, onOpen }: { plugin: PluginInfo; onOpen: () => void }) {
  const client = useClient()
  const status = p.mcp && p.enabled ? mcpStatus[p.mcp.status] : null
  const on = p.tools.filter((t) => t.enabled && !t.viewOnly).length
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <button type="button" onClick={onOpen} className="-my-1 min-w-0 flex-1 rounded-lg py-1 text-left outline-offset-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium">{p.name}</span>
          {status && <Badge variant={status.variant}>{status.label}</Badge>}
          {p.sideEffect && <Badge variant="warning">会改动外部</Badge>}
          {!p.available && <Badge>此服务器不可用</Badge>}
        </div>
        <p className="line-clamp-2 text-sm text-muted-foreground">{p.description || p.mcp?.url}</p>
        {p.available && p.issue ? (
          <p className="mt-0.5 text-xs text-warning">{p.issue}</p>
        ) : (
          p.enabled && p.tools.length > 0 && <p className="mt-0.5 text-xs text-muted-foreground">{on} 个工具可用</p>
        )}
      </button>
      {/* A plugin that is not configured can still be turned off, but not on. */}
      <Switch
        checked={p.enabled}
        disabled={!p.available || (!p.enabled && !!p.issue && p.kind === 'builtin')}
        aria-label={`启用 ${p.name}`}
        onCheckedChange={(enabled) => void client.request({ t: 'plugin.set', pluginId: p.id, enabled }).catch(report)}
      />
    </li>
  )
}

function PluginDetail({ plugin: p, onRemoved }: { plugin: PluginInfo; onRemoved: () => void }) {
  const client = useClient()
  const [editing, setEditing] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [busy, setBusy] = useState('')

  const act = (name: string, run: () => Promise<unknown>) => {
    setBusy(name)
    run()
      .catch(report)
      .finally(() => setBusy(''))
  }
  // Opened before the request so the browser ties the window to this click.
  const signIn = () => {
    const win = window.open('', '_blank')
    act('auth', () =>
      client.request<{ url: string }>({ t: 'mcp.auth', pluginId: p.id }).then(
        ({ url }) => (win ? (win.location.href = url) : location.assign(url)),
        (e: unknown) => {
          win?.close()
          throw e
        },
      ),
    )
  }

  if (editing && p.mcp) return <McpForm plugin={p} onDone={() => setEditing(false)} />
  const tools = p.tools.filter((t) => !t.viewOnly)
  return (
    <DialogBody className="flex flex-col gap-6">
      {p.mcp && (
        <section className="flex flex-col gap-3">
          <div className="rounded-xl bg-muted px-3.5 py-3 text-sm">
            <div className="flex items-center gap-2">
              <Badge variant={mcpStatus[p.mcp.status].variant}>{mcpStatus[p.mcp.status].label}</Badge>
              {p.mcp.server && (
                <span className="truncate text-muted-foreground">
                  {p.mcp.server.name} {p.mcp.server.version}
                </span>
              )}
              {p.mcp.oauth && <Badge variant="outline">OAuth</Badge>}
            </div>
            <code className="mt-1.5 block font-mono text-xs break-all text-muted-foreground">{p.mcp.url}</code>
            {p.mcp.headersSet.length > 0 && <p className="mt-1 text-xs text-muted-foreground">请求头：{p.mcp.headersSet.join('、')}</p>}
          </div>
          {p.mcp.error && <Notice tone={p.mcp.status === 'auth' ? 'warning' : 'error'}>{p.mcp.error}</Notice>}
          <div className="flex flex-wrap gap-2">
            {p.mcp.status === 'auth' && (
              <Button variant="primary" disabled={!!busy} onClick={signIn}>
                <KeyRound /> 登录授权
              </Button>
            )}
            <Button disabled={!!busy || !p.enabled} onClick={() => act('reconnect', () => client.request({ t: 'mcp.reconnect', pluginId: p.id }))}>
              {busy === 'reconnect' ? <Spinner /> : <RefreshCw />} 重新连接
            </Button>
            <Button onClick={() => setEditing(true)}>
              <Pencil /> 编辑
            </Button>
            <Button variant="ghost-destructive" className="ml-auto" onClick={() => setRemoving(true)}>
              <Trash2 /> 移除
            </Button>
          </div>
        </section>
      )}

      {!p.mcp && p.issue && <Notice tone="warning">{p.issue}</Notice>}

      {p.settings.length > 0 && (
        <section>
          <h3 className="mb-3 text-sm font-semibold">设置</h3>
          <SettingsForm settings={p.settings} config={p.config} onSave={(change) => client.request({ t: 'plugin.set', pluginId: p.id, ...change })} />
        </section>
      )}

      <section>
        <h3 className="mb-1 text-sm font-semibold">工具</h3>
        {tools.length === 0 ? (
          <p className="text-sm text-muted-foreground">{p.mcp ? '连接成功后，这里列出服务器提供的工具。' : '这个插件现在没有提供工具。'}</p>
        ) : (
          <ul className="divide-y">
            {tools.map((t) => (
              <li key={t.name} className="flex items-start gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2">
                    <span className="text-sm font-medium">{t.title ?? t.name}</span>
                    {t.title && <code className="font-mono text-xs text-muted-foreground">{t.name}</code>}
                    {t.resourceUri && <Badge variant="outline">带界面</Badge>}
                  </div>
                  {t.description && <p className="line-clamp-3 text-xs text-muted-foreground">{t.description}</p>}
                </div>
                <Switch
                  checked={t.enabled}
                  disabled={!p.enabled}
                  aria-label={`启用工具 ${t.title ?? t.name}`}
                  className="mt-0.5"
                  onCheckedChange={(enabled) => void client.request({ t: 'plugin.tool.set', pluginId: p.id, tool: t.name, enabled }).catch(report)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`移除「${p.name}」？`}
        confirm="移除"
        onConfirm={() => void client.request({ t: 'mcp.remove', pluginId: p.id }).then(onRemoved, report)}
      >
        它的工具不再可用，保存的请求头和登录也会删除。已有对话里的调用记录保留。
      </ConfirmDialog>
    </DialogBody>
  )
}

type HeaderRow = { name: string; value: string }

/** Adds an MCP server, or edits one: a header already set shows only its name and can be removed. */
function McpForm({ plugin, onDone }: { plugin?: PluginInfo; onDone: (added?: PluginInfo) => void }) {
  const client = useClient()
  const [name, setName] = useState(plugin?.name ?? '')
  const [url, setUrl] = useState(plugin?.mcp?.url ?? '')
  const [kept, setKept] = useState(plugin?.mcp?.headersSet ?? [])
  const [rows, setRows] = useState<HeaderRow[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const validUrl = /^https?:\/\/[^\s]+$/.test(url.trim())

  const submit = () => {
    const added = Object.fromEntries(rows.filter((r) => r.name.trim() && r.value.trim()).map((r) => [r.name.trim(), r.value.trim()]))
    setBusy(true)
    setError(null)
    const fail = (e: unknown) => {
      setBusy(false)
      setError(errorText(e))
    }
    if (!plugin) return void client.request<PluginInfo>({ t: 'mcp.add', name: name.trim(), url: url.trim(), ...(Object.keys(added).length && { headers: added }) }).then(onDone, fail)
    const removed = Object.fromEntries((plugin.mcp?.headersSet ?? []).filter((h) => !kept.includes(h) && !(h in added)).map((h) => [h, null]))
    const headers = { ...removed, ...added }
    void client
      .request({ t: 'mcp.update', pluginId: plugin.id, name: name.trim(), url: url.trim(), ...(Object.keys(headers).length && { headers }) })
      .then(() => onDone(), fail)
  }

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <DialogBody className="flex flex-col gap-4">
        <Field label="名称">
          <Input value={name} autoFocus maxLength={60} placeholder="例如：Linear" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="服务器地址" help="Streamable HTTP 端点。需要 OAuth 的服务器在添加后登录。" error={url.trim() && !validUrl ? '需要以 http:// 或 https:// 开头' : null}>
          <Input type="url" value={url} placeholder="https://example.com/mcp" aria-invalid={!!url.trim() && !validUrl} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <div className="flex flex-col gap-2 text-sm">
          <span className="font-medium">请求头（可选）</span>
          {kept.map((h) => (
            <div key={h} className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg bg-muted px-3 py-2 font-mono text-xs">{h}：已设置</code>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`移除请求头 ${h}`} onClick={() => setKept(kept.filter((x) => x !== h))}>
                <X />
              </Button>
            </div>
          ))}
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input aria-label="请求头名称" placeholder="Authorization" value={r.name} className="flex-1" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <Input
                aria-label="请求头的值"
                type="password"
                autoComplete="off"
                placeholder="Bearer …"
                value={r.value}
                className="flex-[1.4]"
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
              />
              <Button type="button" variant="ghost" size="icon-sm" aria-label="移除这一行" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                <X />
              </Button>
            </div>
          ))}
          <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setRows([...rows, { name: '', value: '' }])}>
            <Plus /> 添加请求头
          </Button>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" onClick={() => onDone()}>
          取消
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !name.trim() || !validUrl}>
          {busy ? '连接中…' : plugin ? '保存并重连' : '添加'}
        </Button>
      </DialogFooter>
    </form>
  )
}

// ── Skills ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const skillSource: Record<SkillInfo['source'], string> = { builtin: '内置', upload: '上传', git: 'Git' }

function SkillsTab() {
  const client = useClient()
  const { skills, canInstallSkills } = useHost()
  const [openName, setOpenName] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const open = skills.find((s) => s.name === openName)
  return (
    <>
      <SectionHead
        title="Skills"
        description={
          <>
            Skill 是一个带 <code className="font-mono text-[13px]">SKILL.md</code> 的文件夹（Agent Skills 格式）。任务符合时助手自动使用，也可以在输入框用 / 指定。
          </>
        }
        action={
          <Button variant="primary" disabled={!canInstallSkills} onClick={() => setInstalling(true)}>
            <Plus /> 安装
          </Button>
        }
      />
      {!canInstallSkills && (
        <Notice tone="warning" className="mb-3">
          这台服务器不能解压或拉取 Skill（缺少 unzip 或 git）。
        </Notice>
      )}
      {skills.length === 0 ? (
        <Empty icon={<BookOpen />} title="还没有 Skill">
          从 zip 或 Git 仓库安装，兼容为 Claude 等助手编写的 Agent Skills。
        </Empty>
      ) : (
        <ul className={card}>
          {skills.map((s) => (
            <li key={s.name} className="flex items-center gap-3 px-4 py-3">
              <button type="button" onClick={() => setOpenName(s.name)} className="-my-1 min-w-0 flex-1 rounded-lg py-1 text-left outline-offset-4">
                <div className="flex flex-wrap items-center gap-x-2">
                  <span className="font-medium">{s.name}</span>
                  <Badge variant="outline">{skillSource[s.source]}</Badge>
                  {s.plugin && <Badge variant="outline">随插件提供</Badge>}
                </div>
                <p className="line-clamp-2 text-sm text-muted-foreground">{s.description}</p>
              </button>
              <Switch checked={s.enabled} disabled={!!s.plugin} title={s.plugin ? '随插件开关' : undefined} aria-label={`启用 ${s.name}`} onCheckedChange={(enabled) => void client.request({ t: 'skill.set', name: s.name, enabled }).catch(report)} />
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        只给某个对话用的 Skill：让助手在工作区写 <code className="font-mono">skills/&lt;名称&gt;/SKILL.md</code>，下一轮起在那个对话里生效。
      </p>

      <Dialog open={!!open} onOpenChange={(v) => !v && setOpenName(null)}>
        {open && (
          <DialogContent title={open.name} description={open.description} className="sm:max-w-2xl">
            <SkillDetail key={open.name} skill={open} onRemoved={() => setOpenName(null)} />
          </DialogContent>
        )}
      </Dialog>
      <Dialog open={installing} onOpenChange={setInstalling}>
        <DialogContent title="安装 Skill" description="会安装来源里找到的每一个 Skill；同名的会被替换。">
          {installing && <InstallForm onDone={() => setInstalling(false)} />}
        </DialogContent>
      </Dialog>
    </>
  )
}

function SkillDetail({ skill, onRemoved }: { skill: SkillInfo; onRemoved: () => void }) {
  const client = useClient()
  const [path, setPath] = useState(skill.files[0] ?? 'SKILL.md')
  const [file, setFile] = useState<FilePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)

  useEffect(() => {
    let live = true
    setFile(null)
    setError(null)
    client.request<FilePreview>({ t: 'skill.read', name: skill.name, path }).then(
      (f) => live && setFile(f),
      (e: unknown) => live && setError(errorText(e)),
    )
    return () => {
      live = false
    }
  }, [client, skill.name, path])

  // SKILL.md opens with YAML front matter, which the dialog's header already shows.
  const markdown = /\.md$/i.test(path) && file && !file.binary ? file.text.replace(/^---\n[\s\S]*?\n---\n?/, '') : null
  return (
    <>
      <DialogBody className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">{skillSource[skill.source]}</Badge>
          {skill.origin && <span className="truncate">{skill.origin}</span>}
          {skill.license && <span>许可：{skill.license}</span>}
        </div>
        {skill.files.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {skill.files.map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={f === path}
                onClick={() => setPath(f)}
                className={cn('inline-flex h-7 items-center gap-1 rounded-lg border px-2 font-mono text-xs', f === path ? 'border-transparent bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-hover')}
              >
                <FileText className="size-3" /> {f}
              </button>
            ))}
          </div>
        )}
        <div className="min-h-40 rounded-xl border bg-background p-4">
          {error ? (
            <Notice tone="error">{error}</Notice>
          ) : !file ? (
            <Spinner />
          ) : file.binary ? (
            <p className="text-sm text-muted-foreground">二进制文件，不能预览。</p>
          ) : markdown !== null ? (
            <Markdown text={markdown} className="text-sm" />
          ) : (
            <pre className="font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">{file.text}</pre>
          )}
          {file?.truncated && <p className="mt-3 text-xs text-muted-foreground">只显示了文件的开头。</p>}
        </div>
      </DialogBody>
      {skill.source !== 'builtin' && (
        <DialogFooter>
          <Button variant="ghost-destructive" onClick={() => setRemoving(true)}>
            <Trash2 /> 卸载
          </Button>
        </DialogFooter>
      )}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`卸载「${skill.name}」？`}
        confirm="卸载"
        onConfirm={() => void client.request({ t: 'skill.remove', name: skill.name }).then(onRemoved, report)}
      >
        它的文件会从服务器删除，可以再从原来的来源安装。
      </ConfirmDialog>
    </>
  )
}

function InstallForm({ onDone }: { onDone: () => void }) {
  const client = useClient()
  const input = useRef<HTMLInputElement>(null)
  const [from, setFrom] = useState<'git' | 'zip'>('git')
  const [git, setGit] = useState('')
  const [ref, setRef] = useState('')
  const [path, setPath] = useState('')
  const [zip, setZip] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState<SkillInfo[] | null>(null)
  const valid = from === 'git' ? /^(https?:\/\/|git@)\S+$/.test(git.trim()) : !!zip && zip.size <= MAX_UPLOAD

  const install = async () => {
    setBusy(true)
    setError(null)
    try {
      const source: SkillSource =
        from === 'git' ? { git: git.trim(), ...(ref.trim() && { ref: ref.trim() }), ...(path.trim() && { path: path.trim() }) } : { upload: (await client.upload(zip!)).id }
      setAdded(await client.request<SkillInfo[]>({ t: 'skill.install', source }))
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }

  if (added)
    return (
      <>
        <DialogBody>
          <Notice title={added.length ? `已安装 ${added.length} 个 Skill` : '来源里没有找到 Skill'}>
            {added.length ? added.map((s) => s.name).join('、') : '需要至少一个带 SKILL.md 的文件夹。'}
          </Notice>
        </DialogBody>
        <DialogFooter>
          <Button variant="primary" onClick={onDone}>
            完成
          </Button>
        </DialogFooter>
      </>
    )

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault()
        void install()
      }}
    >
      <DialogBody className="flex flex-col gap-4">
        <Tabs value={from} onValueChange={(v) => setFrom(v as 'git' | 'zip')}>
          <TabsList>
            <TabsTrigger value="git">Git 仓库</TabsTrigger>
            <TabsTrigger value="zip">上传 zip</TabsTrigger>
          </TabsList>
          <TabsContent value="git" className="mt-4 flex flex-col gap-4">
            <Field label="仓库地址">
              <Input value={git} autoFocus placeholder="https://github.com/anthropics/skills" onChange={(e) => setGit(e.target.value)} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="分支或标签（可选）">
                <Input value={ref} placeholder="main" onChange={(e) => setRef(e.target.value)} />
              </Field>
              <Field label="子目录（可选）">
                <Input value={path} placeholder="skills/pdf" onChange={(e) => setPath(e.target.value)} />
              </Field>
            </div>
          </TabsContent>
          <TabsContent value="zip" className="mt-4">
            <input ref={input} type="file" accept=".zip,.skill,application/zip" hidden onChange={(e) => setZip(e.target.files?.[0] ?? null)} />
            <button
              type="button"
              onClick={() => input.current?.click()}
              className="flex w-full flex-col items-center gap-1.5 rounded-xl border border-dashed px-4 py-8 text-sm text-muted-foreground hover:bg-hover"
            >
              <Upload className="size-5" />
              {zip ? <span className="text-foreground">{zip.name}</span> : '选择一个 zip 文件（不超过 20 MB）'}
            </button>
            {zip && zip.size > MAX_UPLOAD && <p className="mt-2 text-xs text-destructive">文件超过 20 MB。</p>}
          </TabsContent>
        </Tabs>
        <p className="text-xs text-muted-foreground">Skill 里的说明和脚本会被助手读取和执行，只安装你信任的来源。</p>
        {error && <Notice tone="error">{error}</Notice>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" onClick={onDone}>
          取消
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !valid}>
          {busy ? '安装中…' : '安装'}
        </Button>
      </DialogFooter>
    </form>
  )
}
