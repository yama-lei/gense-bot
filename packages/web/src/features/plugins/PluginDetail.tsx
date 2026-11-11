// The detail of a plugin or Skill (roadmap-6 B2): a dialog on desktop, full screen on a phone. Settings, tools one by
// one, connection state and why it failed, and removal.
import type { FilePreview, McpStatus, PluginInfo, SkillInfo } from '@gense/protocol'
import { FileText, KeyRound, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { report, useClient } from '../../app/client'
import { cn } from '../../lib/cn'
import { errorText } from '../../lib/format'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { ConfirmDialog, DialogBody, DialogFooter } from '../../ui/dialog'
import { Notice, Spinner } from '../../ui/feedback'
import { Field, Input } from '../../ui/input'
import { Switch } from '../../ui/switch'
import { Markdown } from '../chat/Markdown'
import { maskUrl } from './catalog'
import { SettingsForm } from './SettingsForm'

export const mcpStatus: Record<McpStatus, { label: string; variant: 'neutral' | 'accent' | 'success' | 'warning' | 'destructive' }> = {
  connecting: { label: '连接中', variant: 'accent' },
  ready: { label: '已连接', variant: 'success' },
  auth: { label: '需要登录', variant: 'warning' },
  error: { label: '连接失败', variant: 'destructive' },
  off: { label: '未启用', variant: 'neutral' },
}

export function PluginDetail({ plugin: p, onRemoved }: { plugin: PluginInfo; onRemoved: () => void }) {
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
      <div className="flex items-center gap-3 rounded-xl border px-3.5 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
            启用
            {p.sideEffect && <Badge variant="warning">会改动外部</Badge>}
          </div>
          <p className="text-xs text-muted-foreground">{!p.available ? '这台服务器不能运行它。' : '关闭后，助手不能调用它的工具。'}</p>
        </div>
        {/* A built-in plugin that is not configured can still be turned off, but not on. */}
        <Switch
          checked={p.enabled}
          disabled={!p.available || (!p.enabled && !!p.issue && p.kind === 'builtin')}
          aria-label={`启用 ${p.name}`}
          onCheckedChange={(enabled) => void client.request({ t: 'plugin.set', pluginId: p.id, enabled }).catch(report)}
        />
      </div>

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
            <code className="mt-1.5 block font-mono text-xs break-all text-muted-foreground">{maskUrl(p.mcp.url)}</code>
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
export function McpForm({ plugin, onDone }: { plugin?: PluginInfo; onDone: (added?: PluginInfo) => void }) {
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

const skillSource: Record<SkillInfo['source'], string> = { builtin: '内置', upload: '上传', git: 'Git' }

export function SkillDetail({ skill, onRemoved }: { skill: SkillInfo; onRemoved: () => void }) {
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
          <label className="ml-auto flex items-center gap-2 text-sm text-foreground">
            {skill.plugin ? `随插件 ${skill.plugin} 开关` : '启用'}
            <Switch
              checked={skill.enabled}
              disabled={!!skill.plugin}
              onCheckedChange={(enabled) => void client.request({ t: 'skill.set', name: skill.name, enabled }).catch(report)}
            />
          </label>
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
