// The Library: every file the assistant wrote or you uploaded, in every conversation and project (roadmap-7 D4).
// The server lists, filters and pages them; this asks for a page at a time.
import type { FileKind, LibraryFile } from '@gense/protocol'
import { BookMarked, Code, Download, File, FileText, FolderClosed, Image, LayoutGrid, List, MessageCircle, Search, Table2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { report, useClient, useHost } from '../../app/client'
import { Page } from '../../app/Shell'
import { cn } from '../../lib/cn'
import { baseName, errorText, formatBytes, formatTime } from '../../lib/format'
import { useSettled } from '../../lib/hooks'
import { Link } from '../../lib/router'
import { Button } from '../../ui/button'
import { Empty, Notice, Skeleton, Spinner } from '../../ui/feedback'
import { Input } from '../../ui/input'
import { Tabs, TabsList, TabsTrigger } from '../../ui/tabs'

const PAGE = 60

const kinds: Record<FileKind, { label: string; icon: typeof File; tone: string }> = {
  doc: { label: '文档', icon: FileText, tone: 'text-[var(--series-1)]' },
  image: { label: '图片', icon: Image, tone: 'text-[var(--series-5)]' },
  data: { label: '数据', icon: Table2, tone: 'text-[var(--series-3)]' },
  code: { label: '代码', icon: Code, tone: 'text-[var(--series-2)]' },
  other: { label: '其他', icon: File, tone: 'text-muted-foreground' },
}

interface Loaded {
  items: LibraryFile[]
  next?: string
}

export default function LibraryPage() {
  const client = useClient()
  const { trees, projects } = useHost()
  const [filter, setFilter] = useState<FileKind | 'all'>('all')
  const [query, setQuery] = useState('')
  const q = useSettled(query.trim(), 300)
  const [grid, setGrid] = useState(true)
  const [list, setList] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [more, setMore] = useState(false)

  const ask = (cursor?: string) => client.listLibrary({ ...(q && { query: q }), ...(filter !== 'all' && { kind: filter }), ...(cursor && { cursor }), limit: PAGE })

  useEffect(() => {
    let live = true
    setList(null)
    setError(null)
    ask().then(
      (page) => live && setList(page),
      (e: unknown) => live && setError(errorText(e)),
    )
    return () => {
      live = false
    }
  }, [client, q, filter]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = async () => {
    if (!list?.next) return
    setMore(true)
    try {
      const page = await ask(list.next)
      setList((l) => l && { items: [...l.items, ...page.items], ...(page.next && { next: page.next }) })
    } catch (e) {
      report(e)
    }
    setMore(false)
  }

  // Where a file lives: its conversation, or its project.
  const placeOf = (f: LibraryFile) =>
    f.treeId
      ? { to: { name: 'chat', id: f.treeId } as const, label: trees?.find((t) => t.id === f.treeId)?.title || '新对话', icon: MessageCircle }
      : { to: { name: 'projects', id: f.projectId! } as const, label: projects?.find((p) => p.id === f.projectId)?.name || '项目', icon: FolderClosed }
  const download = (f: LibraryFile) => void (f.treeId ? client.downloadFile(f.treeId, f.path) : client.readProjectFile(f.projectId!, f.path)).catch(report)
  const searching = !!q || filter !== 'all'

  return (
    <Page wide title="资料库" description="Gense 写出的文档、图表、代码，和你上传到对话或项目的文件，都收在这里。">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Tabs value={filter} onValueChange={(v) => setFilter(v as FileKind | 'all')}>
          <TabsList>
            <TabsTrigger value="all">全部</TabsTrigger>
            {(Object.keys(kinds) as FileKind[]).map((k) => (
              <TabsTrigger key={k} value={k}>
                {kinds[k].label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="relative min-w-40 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索文件名" aria-label="搜索文件" className="pl-9" />
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

      {error ? (
        <Notice tone="error">{error}</Notice>
      ) : list === null ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <Skeleton key={i} className="h-32 rounded-2xl" />
          ))}
        </div>
      ) : list.items.length === 0 ? (
        <Empty icon={<BookMarked />} title={searching ? '没有匹配的文件' : '资料库还是空的'}>
          {searching ? '换个关键词或类型试试。' : '让 Gense 写一份文档、做一张图表，或在对话里上传文件，它们会自动出现在这里。'}
        </Empty>
      ) : (
        <>
          {grid ? (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {list.items.map((f) => {
                const kind = kinds[f.kind]
                const place = placeOf(f)
                return (
                  <li key={`${f.treeId ?? f.projectId}:${f.path}`} className="group relative flex flex-col overflow-hidden rounded-2xl border bg-card transition-[border-color,box-shadow] hover:border-input hover:shadow-float">
                    <Link to={place.to} title={f.path} className="flex flex-1 flex-col">
                      <span className="grid h-20 place-items-center bg-muted/60">
                        <kind.icon className={cn('size-8', kind.tone)} strokeWidth={1.5} />
                      </span>
                      <span className="flex flex-col gap-0.5 p-3">
                        <span className="truncate text-sm font-medium">{baseName(f.path)}</span>
                        <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                          <place.icon className="size-3 shrink-0" /> <span className="truncate">{place.label}</span>
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatBytes(f.size)} · {formatTime(f.mtime)}
                        </span>
                      </span>
                    </Link>
                    <Button
                      size="icon-sm"
                      aria-label={`下载 ${baseName(f.path)}`}
                      onClick={() => download(f)}
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
              {list.items.map((f) => {
                const kind = kinds[f.kind]
                const place = placeOf(f)
                return (
                  <li key={`${f.treeId ?? f.projectId}:${f.path}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-hover">
                    <kind.icon className={cn('size-4.5 shrink-0', kind.tone)} />
                    <Link to={place.to} title={f.path} className="flex min-w-0 flex-1 items-baseline gap-3">
                      <span className="min-w-0 truncate text-sm font-medium">{baseName(f.path)}</span>
                      <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-xs text-muted-foreground">
                        <place.icon className="size-3 shrink-0" /> <span className="truncate">{place.label}</span>
                      </span>
                    </Link>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums max-sm:hidden">{formatBytes(f.size)}</span>
                    <span className="w-24 shrink-0 text-right text-xs text-muted-foreground max-sm:hidden">{formatTime(f.mtime)}</span>
                    <Button variant="ghost" size="icon-sm" aria-label={`下载 ${baseName(f.path)}`} onClick={() => download(f)}>
                      <Download />
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
          {list.next && (
            <div className="mt-4 flex justify-center">
              <Button variant="ghost" onClick={() => void loadMore()} disabled={more}>
                {more && <Spinner />} 加载更多
              </Button>
            </div>
          )}
        </>
      )}
    </Page>
  )
}
