// The Library: every file the assistant wrote or you uploaded, across conversations. The server lists files per
// conversation, so this asks the most recent ones and merges the answers.
import type { FileEntry } from '@gense/protocol'
import { BookMarked, Code, Download, File, FileText, Image, LayoutGrid, List, MessageCircle, RefreshCw, Search, Table2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { report, useClient, useHost } from '../../app/client'
import { Page } from '../../app/Shell'
import { cn } from '../../lib/cn'
import { baseName, formatBytes, formatTime } from '../../lib/format'
import { Link } from '../../lib/router'
import { Button } from '../../ui/button'
import { Empty, Skeleton } from '../../ui/feedback'
import { Input } from '../../ui/input'
import { Tabs, TabsList, TabsTrigger } from '../../ui/tabs'
import { Tooltip } from '../../ui/tooltip'

/** Conversations asked for their files, newest first. */
const SCANNED = 30

const kinds = {
  doc: { label: '文档', icon: FileText, tone: 'text-[var(--series-1)]', ext: /\.(md|txt|pdf|docx?|rtf|html?|pptx?)$/i },
  image: { label: '图片', icon: Image, tone: 'text-[var(--series-5)]', ext: /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i },
  data: { label: '数据', icon: Table2, tone: 'text-[var(--series-3)]', ext: /\.(csv|tsv|xlsx?|json|ya?ml|xml|sqlite|parquet)$/i },
  code: { label: '代码', icon: Code, tone: 'text-[var(--series-2)]', ext: /\.(tsx?|jsx?|py|go|rs|java|c|cc|cpp|h|sh|sql|css|rb|php|swift|kt|toml)$/i },
  other: { label: '其他', icon: File, tone: 'text-muted-foreground', ext: /$^/ },
}
type Kind = keyof typeof kinds
const kindOf = (path: string): Kind => (Object.keys(kinds) as Kind[]).find((k) => kinds[k].ext.test(path)) ?? 'other'

interface Item extends FileEntry {
  treeId: string
  chat: string
  kind: Kind
}

export default function LibraryPage() {
  const client = useClient()
  const { trees } = useHost()
  const [items, setItems] = useState<Item[] | null>(null)
  const [round, setRound] = useState(0)
  const [filter, setFilter] = useState<Kind | 'all'>('all')
  const [query, setQuery] = useState('')
  const [grid, setGrid] = useState(true)
  const ready = trees !== null
  // Which conversations to ask: decided when the list first arrives, not on every title change.
  const scanned = useMemo(() => [...(trees ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, SCANNED), [ready, round]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!ready) return
    let live = true
    setItems(null)
    void Promise.all(
      scanned.map((t) =>
        client.request<FileEntry[]>({ t: 'files.list', treeId: t.id }).then(
          (files) => files.filter((f) => !f.readOnly).map((f): Item => ({ ...f, treeId: t.id, chat: t.title || '新对话', kind: kindOf(f.path) })),
          () => [] as Item[],
        ),
      ),
    ).then((lists) => live && setItems(lists.flat().sort((a, b) => b.mtime - a.mtime)))
    return () => {
      live = false
    }
  }, [client, ready, scanned])

  const q = query.trim().toLowerCase()
  const shown = (items ?? []).filter((f) => (filter === 'all' || f.kind === filter) && (!q || f.path.toLowerCase().includes(q) || f.chat.toLowerCase().includes(q)))
  const total = (items ?? []).reduce((n, f) => n + f.size, 0)
  const count = (k: Kind) => (items ?? []).filter((f) => f.kind === k).length

  return (
    <Page
      wide
      title="资料库"
      description={items ? `${items.length} 个文件 · ${formatBytes(total)} · 来自最近 ${scanned.length} 个对话` : 'Gense 写出的文档、图表、代码，和你上传的文件，都收在这里。'}
      actions={
        <Tooltip label="重新扫描">
          <Button size="icon" aria-label="重新扫描" disabled={items === null} onClick={() => setRound((r) => r + 1)}>
            <RefreshCw />
          </Button>
        </Tooltip>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Tabs value={filter} onValueChange={(v) => setFilter(v as Kind | 'all')}>
          <TabsList>
            <TabsTrigger value="all">全部</TabsTrigger>
            {(Object.keys(kinds) as Kind[]).map((k) => (
              <TabsTrigger key={k} value={k} disabled={!!items && count(k) === 0}>
                {kinds[k].label}
                {!!items && count(k) > 0 && <span className="text-xs opacity-60">{count(k)}</span>}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="relative min-w-40 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索文件名或对话" aria-label="搜索文件" className="pl-9" />
        </div>
        <div role="radiogroup" aria-label="视图" className="flex gap-0.5 rounded-lg bg-muted p-0.5">
          {[
            { on: true, label: '网格', icon: <LayoutGrid /> },
            { on: false, label: '列表', icon: <List /> },
          ].map((v) => (
            <button key={v.label} type="button" role="radio" aria-checked={grid === v.on} aria-label={v.label} onClick={() => setGrid(v.on)} className={cn('grid size-8 place-items-center rounded-md text-muted-foreground [&_svg]:size-4', grid === v.on && 'bg-card text-foreground shadow-float')}>
              {v.icon}
            </button>
          ))}
        </div>
      </div>

      {items === null ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <Skeleton key={i} className="h-32 rounded-2xl" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <Empty icon={<BookMarked />} title={items.length ? '没有匹配的文件' : '资料库还是空的'}>
          {items.length ? '换个关键词或类型试试。' : '让 Gense 写一份文档、做一张图表，或在对话里上传文件，它们会自动出现在这里。'}
        </Empty>
      ) : grid ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {shown.map((f) => {
            const kind = kinds[f.kind]
            return (
              <li key={f.treeId + f.path} className="group relative flex flex-col overflow-hidden rounded-2xl border bg-card transition-[border-color,box-shadow] hover:border-input hover:shadow-float">
                <Link to={{ name: 'chat', id: f.treeId }} title={f.path} className="flex flex-1 flex-col">
                  <span className="grid h-20 place-items-center bg-muted/60">
                    <kind.icon className={cn('size-8', kind.tone)} strokeWidth={1.5} />
                  </span>
                  <span className="flex flex-col gap-0.5 p-3">
                    <span className="truncate text-sm font-medium">{baseName(f.path)}</span>
                    <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                      <MessageCircle className="size-3 shrink-0" /> <span className="truncate">{f.chat}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatBytes(f.size)} · {formatTime(f.mtime)}
                    </span>
                  </span>
                </Link>
                <Button
                  size="icon-sm"
                  aria-label={`下载 ${baseName(f.path)}`}
                  onClick={() => void client.downloadFile(f.treeId, f.path).catch(report)}
                  className="absolute top-2 right-2 opacity-0 shadow-float group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
                >
                  <Download />
                </Button>
              </li>
            )
          })}
        </ul>
      ) : (
        <ul className="flex flex-col divide-y overflow-hidden rounded-2xl border bg-card">
          {shown.map((f) => {
            const kind = kinds[f.kind]
            return (
              <li key={f.treeId + f.path} className="flex items-center gap-3 px-4 py-2.5 hover:bg-hover">
                <kind.icon className={cn('size-4.5 shrink-0', kind.tone)} />
                <Link to={{ name: 'chat', id: f.treeId }} title={f.path} className="flex min-w-0 flex-1 items-baseline gap-3">
                  <span className="min-w-0 truncate text-sm font-medium">{baseName(f.path)}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{f.chat}</span>
                </Link>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums max-sm:hidden">{formatBytes(f.size)}</span>
                <span className="w-24 shrink-0 text-right text-xs text-muted-foreground max-sm:hidden">{formatTime(f.mtime)}</span>
                <Button variant="ghost" size="icon-sm" aria-label={`下载 ${baseName(f.path)}`} onClick={() => void client.downloadFile(f.treeId, f.path).catch(report)}>
                  <Download />
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </Page>
  )
}
