// Memory (roadmap-7 A1–A6): what the assistant keeps in mind across conversations, on the web and in chat apps.
// The server keeps the entries and sends the enabled ones to the model; the model can add, correct and remove them too.
import type { Memory, MemorySource } from '@gense/protocol'
import { MEMORY_LIMITS } from '@gense/protocol'
import { Bot, Brain, FolderClosed, Globe, MessageCircle, PencilLine, Plus, Search, Trash2, UserRound } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { report, useClient, useHost, useMemories, useProjects } from '../../app/client'
import { Page } from '../../app/Shell'
import { cn } from '../../lib/cn'
import { formatTime } from '../../lib/format'
import { projectColors } from '../../lib/lab'
import { Link } from '../../lib/router'
import { Button } from '../../ui/button'
import { ConfirmDialog } from '../../ui/dialog'
import { Empty, Skeleton, Spinner } from '../../ui/feedback'
import { Input } from '../../ui/input'
import { DropdownMenu, DropdownMenuCheckItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '../../ui/menu'
import { Switch } from '../../ui/switch'
import { Tabs, TabsList, TabsTrigger } from '../../ui/tabs'

const examples = ['回答尽量简洁，先给结论', '我是前端工程师，主要写 TypeScript', '时间一律用北京时间', '写邮件时用正式一点的语气']

const sources: Record<MemorySource, { label: string; icon: ReactNode }> = {
  manual: { label: '手动添加', icon: <UserRound /> },
  saved: { label: '从回答存入', icon: <MessageCircle /> },
  model: { label: 'Gense 记下的', icon: <Bot /> },
}

type Filter = 'all' | 'global' | 'project'

export default function MemoryPage() {
  const client = useClient()
  const all = useMemories()
  const projects = useProjects() ?? []
  const { prefs } = useHost()
  const on = prefs?.useMemory ?? true
  const writes = prefs?.memoryWrites ?? 'auto'
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [editing, setEditing] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)

  const add = (text: string) => {
    setAdding(true)
    client.addMemory({ text }).then(
      () => {
        setAdding(false)
        setDraft('')
      },
      (e: unknown) => {
        setAdding(false)
        report(e)
      },
    )
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (draft.trim() && !adding) add(draft.trim())
  }

  const q = query.trim().toLowerCase()
  const shown = (all ?? []).filter((m) => (filter === 'all' || (filter === 'global') === (m.projectId === null)) && (!q || m.text.toLowerCase().includes(q)))
  const full = (all?.length ?? 0) >= MEMORY_LIMITS.entries

  return (
    <Page title="记忆" description="Gense 在每个对话里都会参考这些关于你的事，包括飞书里的对话。你可以让它记住或忘掉什么，它也会在你说起长期有用的事时自己记下。">
      <div className="mb-6 flex flex-col divide-y rounded-2xl border bg-card">
        <div className="flex items-center gap-3 p-4">
          <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground', on && 'bg-accent-soft text-accent')}>
            <Brain className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">在对话中参考记忆</div>
            <div className="text-sm text-muted-foreground">{on ? `已开启 · ${(all ?? []).filter((m) => m.enabled).length} 条生效` : '已关闭：Gense 看不到记忆，也不会记下新的；已有的记忆仍会保留'}</div>
          </div>
          <Switch checked={on} disabled={!prefs} onCheckedChange={(v) => client.setPrefs({ useMemory: v })} aria-label="在对话中参考记忆" />
        </div>
        {on && (
          <div className="flex items-center gap-3 p-4 pl-17 max-sm:pl-4">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">主动记住长期有用的事</div>
              <div className="text-sm text-muted-foreground">{writes === 'explicit' ? '只有你说“记住……”时，Gense 才会新增记忆' : '你提到长期有用的事时，Gense 也会主动记下，并在回答里告诉你'}</div>
            </div>
            <Switch checked={writes !== 'explicit'} disabled={!prefs} onCheckedChange={(v) => client.setPrefs({ memoryWrites: v ? 'auto' : 'explicit' })} aria-label="主动记住长期有用的事" />
          </div>
        )}
      </div>

      <form onSubmit={submit} className="mb-3 flex gap-2">
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={MEMORY_LIMITS.text} disabled={full} placeholder={full ? `记忆已满（${MEMORY_LIMITS.entries} 条），请先删除一些` : '添加一条记忆，例如：我住在上海，吃素'} aria-label="新记忆" className="h-10" />
        <Button type="submit" variant="primary" size="lg" disabled={!draft.trim() || adding || full}>
          {adding ? <Spinner /> : <Plus />} 记住
        </Button>
      </form>

      {!all ? (
        <div className="mt-6 flex flex-col gap-2">
          <Skeleton className="h-14 rounded-2xl" />
          <Skeleton className="h-14 rounded-2xl" />
          <Skeleton className="h-14 rounded-2xl" />
        </div>
      ) : all.length === 0 ? (
        <Empty icon={<Brain />} title="还没有记忆" className="mt-6">
          从一条开始，在对话里说“记住……”，或在任意回答下点「更多 → 存入记忆」。
          <span className="mt-3 flex flex-wrap justify-center gap-1.5">
            {examples.map((e) => (
              <button key={e} type="button" onClick={() => add(e)} className="rounded-full border bg-card px-3 py-1 text-sm text-foreground hover:bg-hover">
                + {e}
              </button>
            ))}
          </span>
        </Empty>
      ) : (
        <>
          <div className="mt-6 mb-2 flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 basis-56">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`搜索 ${all.length} 条记忆`} aria-label="搜索记忆" className="pl-9" />
            </div>
            {projects.length > 0 && (
              <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
                <TabsList>
                  <TabsTrigger value="all">全部</TabsTrigger>
                  <TabsTrigger value="global">通用</TabsTrigger>
                  <TabsTrigger value="project">项目内</TabsTrigger>
                </TabsList>
              </Tabs>
            )}
            <Button variant="ghost-destructive" onClick={() => setClearing(true)}>
              全部清除
            </Button>
          </div>
          <ul className="flex flex-col divide-y overflow-hidden rounded-2xl border bg-card">
            {shown.map((m) => (
              <MemoryRow key={m.id} memory={m} editing={editing === m.id} onEdit={(v) => setEditing(v ? m.id : null)} />
            ))}
            {shown.length === 0 && <li className="px-4 py-8 text-center text-sm text-muted-foreground">{q ? `没有匹配「${query.trim()}」的记忆` : '这一类还没有记忆'}</li>}
          </ul>
          <p className="mt-2 px-1 text-xs text-muted-foreground">
            {all.length} / {MEMORY_LIMITS.entries} 条
          </p>
        </>
      )}

      <ConfirmDialog
        open={clearing}
        onOpenChange={setClearing}
        title="清除全部记忆？"
        confirm="全部清除"
        onConfirm={() => {
          for (const m of all ?? []) client.removeMemory(m.id)
        }}
      >
        {all?.length ?? 0} 条记忆会从你的账户里删除，所有设备上都会消失，无法恢复。
      </ConfirmDialog>
    </Page>
  )
}

function MemoryRow({ memory: m, editing, onEdit }: { memory: Memory; editing: boolean; onEdit: (v: boolean) => void }) {
  const client = useClient()
  const projects = useProjects() ?? []
  const { trees } = useHost()
  const project = m.projectId ? projects.find((p) => p.id === m.projectId) : undefined
  const from = m.treeId ? trees?.find((t) => t.id === m.treeId) : undefined
  const source = sources[m.source]

  return (
    <li className="group flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5 text-muted-foreground [&_svg]:size-4" title={source.label}>
        {source.icon}
      </span>
      <div className="min-w-0 flex-1">
        {editing ? (
          <Input
            autoFocus
            defaultValue={m.text}
            maxLength={MEMORY_LIMITS.text}
            aria-label="编辑记忆"
            onBlur={(e) => {
              const text = e.target.value.trim()
              if (text && text !== m.text) client.updateMemory(m.id, { text })
              onEdit(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') onEdit(false)
            }}
          />
        ) : (
          <p className={cn('text-sm break-words', !m.enabled && 'text-muted-foreground line-through')}>{m.text}</p>
        )}
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          <span>{source.label}</span>
          {from && (
            <>
              ·
              <Link to={{ name: 'chat', id: from.id }} className="max-w-48 truncate underline-offset-4 hover:text-foreground hover:underline">
                {from.title || '新对话'}
              </Link>
            </>
          )}
          · <span>{formatTime(m.updatedAt)}</span>
          {project && (
            <>
              ·
              <span className="inline-flex items-center gap-1">
                <FolderClosed className="size-3" style={{ color: projectColors[project.color] }} /> 只在「{project.name}」
              </span>
            </>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
        {projects.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="生效范围">
                {project ? <FolderClosed /> : <Globe />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel>在哪些对话里生效</DropdownMenuLabel>
              <DropdownMenuCheckItem checked={!m.projectId} onSelect={() => m.projectId && client.updateMemory(m.id, { projectId: null })}>
                <Globe /> 所有对话
              </DropdownMenuCheckItem>
              <DropdownMenuSeparator />
              {projects.map((p) => (
                <DropdownMenuCheckItem key={p.id} checked={m.projectId === p.id} onSelect={() => m.projectId !== p.id && client.updateMemory(m.id, { projectId: p.id })}>
                  <FolderClosed style={{ color: projectColors[p.color] }} /> <span className="truncate">只在「{p.name}」</span>
                </DropdownMenuCheckItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Button variant="ghost" size="icon-sm" aria-label="编辑" onClick={() => onEdit(true)}>
          <PencilLine />
        </Button>
        <Button variant="ghost-destructive" size="icon-sm" aria-label="删除" onClick={() => client.removeMemory(m.id)}>
          <Trash2 />
        </Button>
      </div>
      <Switch checked={m.enabled} onCheckedChange={(v) => client.updateMemory(m.id, { enabled: v })} aria-label="启用这条记忆" className="mt-0.5" />
    </li>
  )
}
