import { ArrowDown, Check, ChevronDown, Copy, Download, FolderInput, ExternalLink, FolderOpen, Ghost, Globe, Link2, Minimize2, Pencil, Pin, PinOff, Radio, RefreshCw, Share, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { report, useChat, useClient, useFiles, useHost, useTools, projectOf, useProjects, useShares, findTree } from '../../app/client'
import { SidebarToggle } from '../../app/Shell'
import { phoneQuery } from '../../app/shell-context'
import { cn } from '../../lib/cn'
import { copyText, formatTime, saveBlob } from '../../lib/format'
import { useFlash, useMediaQuery } from '../../lib/hooks'
import { projectColors, useLab } from '../../lib/lab'
import { href, Link, navigate } from '../../lib/router'
import type { Outgoing, ToolCall, Turn } from '../../lib/types'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter } from '../../ui/dialog'
import { Skeleton, Spinner } from '../../ui/feedback'
import { Input } from '../../ui/input'
import { DropdownMenu, DropdownMenuCheckItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '../../ui/menu'
import { Tooltip } from '../../ui/tooltip'
import { useAside } from './Aside'
import { btwCommand, compactCommand } from '../../lib/commands'
import { CompactionLine } from './Compaction'
import { Composer } from './Composer'
import { footnote } from './HomePage'
import { TurnView, type TurnContext } from './Turn'
import { ViewSlot } from './ViewSlot'
import { WorkspacePanel } from './WorkspacePanel'
import { buildSnapshot } from '../share/snapshot'
import { sharePath } from '@gense/protocol'
import { toast } from 'sonner'

/** What the side panel holds: one call's view, or the conversation's files. */
type Panel = { kind: 'view'; callId: string } | { kind: 'files'; path: string | null }

const NEAR_BOTTOM = 80

/** The conversation as a Markdown document: what was asked and what was answered, in order. */
function toMarkdown(title: string, turns: Turn[]) {
  const parts = [`# ${title || '新对话'}`]
  for (const t of turns) {
    const asked = t.event ? `事件：${t.event.title}` : (t.brief ?? t.userMessage)
    if (asked) parts.push(`## 你\n\n${asked}`)
    if (t.assistantMessage) parts.push(`## Gense\n\n${t.assistantMessage}`)
    if (t.sources.length) parts.push(t.sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join('\n'))
  }
  return parts.join('\n\n') + '\n'
}

/** Keeps the transcript at its end while the reader is there, and leaves it alone once they scroll up. */
function useFollow(ready: boolean) {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const [away, setAway] = useState(false)

  const toBottom = useCallback((smooth = false) => {
    const el = scroller.current
    if (!el) return
    following.current = true
    setAway(false)
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'instant' })
  }, [])

  useLayoutEffect(() => {
    if (ready) toBottom()
  }, [ready, toBottom])

  // Text streams in, views load and resize: all of it changes the content's height.
  useEffect(() => {
    const el = content.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      const s = scroller.current
      if (s && following.current) s.scrollTop = s.scrollHeight
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ready])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM
    following.current = near
    setAway(!near)
  }
  return { scroller, content, away, toBottom, onScroll }
}

export function ChatPage({ treeId }: { treeId: string }) {
  const client = useClient()
  const { models } = useHost()
  const tools = useTools()
  const phone = useMediaQuery(phoneQuery)
  const { tree, loaded, turns, running, entryCount, compaction } = useChat(treeId)
  const { wide } = useLab()
  const [panel, setPanel] = useState<Panel | null>(null)
  const [sharing, setSharing] = useState(false)
  const column = wide ? 'max-w-5xl' : 'max-w-3xl'
  const files = useFiles(treeId, panel?.kind === 'files', entryCount)
  const { scroller, content, away, toBottom, onScroll } = useFollow(loaded)
  const temporary = !!tree?.temporary
  useLeaveTemporary(treeId, temporary)

  const aside = useAside(treeId)
  const send = useCallback(
    (message: Outgoing) => {
      // `/顺便问` is answered beside the chat, which stays where it is.
      if (message.command?.id === btwCommand.id) return aside.ask(message.text)
      toBottom()
      // `/压缩上下文` runs here; what was typed with it says what the summary should keep.
      if (message.command?.id === compactCommand.id) client.compact(treeId, message.text)
      else client.send(treeId, message).catch(report)
    },
    [client, treeId, toBottom, aside.ask],
  )

  const ctx = useMemo<TurnContext>(
    () => ({
      treeId,
      tools,
      models,
      busy: running,
      onRegenerate: (turn) => client.regenerate(treeId, turn),
      onEdit: (turn, text) => client.edit(treeId, turn, text),
      onShowBranch: (id) => client.showBranch(treeId, id),
      onSend: (text) => send({ text }),
      onDisplayMode: (call, mode) => setPanel(mode === 'inline' ? null : { kind: 'view', callId: call.id }),
      panelCallId: panel?.kind === 'view' ? panel.callId : undefined,
    }),
    [client, treeId, tools, models, running, send, panel],
  )

  // The call whose view the panel shows; it closes when the branch shown no longer has that call.
  const panelCall = useMemo(() => {
    if (panel?.kind !== 'view') return undefined
    for (const t of turns) for (const b of t.blocks) if (b.kind === 'tool' && b.call.id === panel.callId) return b.call
    return undefined
  }, [panel, turns])
  useEffect(() => {
    if (loaded && panel?.kind === 'view' && !panelCall) setPanel(null)
  }, [loaded, panel, panelCall])

  const empty = loaded && turns.length === 0

  return (
    <div className="relative flex h-full min-w-0">
      <div className={cn('flex h-full min-w-0 flex-1 flex-col', panel && phone && 'hidden')}>
        <header className="flex h-13 shrink-0 items-center gap-1 px-2 md:px-3">
          <SidebarToggle />
          <TitleMenu treeId={treeId} title={tree?.title ?? ''} pinned={!!tree?.pinned} temporary={temporary} canCompact={turns.length > 0 && !running} onExport={() => saveBlob(`${tree?.title || '对话'}.md`, new Blob([toMarkdown(tree?.title ?? '', turns)], { type: 'text/markdown' }))} />
          {tree?.source && (
            <Badge variant="outline" className="max-sm:hidden">
              <Radio /> {tree.source.label || tree.source.kind}
            </Badge>
          )}
          <span className="flex-1" />
          {!temporary && (
            <Button variant="ghost" size="sm" disabled={turns.length === 0} onClick={() => setSharing(true)} className="gap-1.5 text-muted-foreground max-sm:hidden">
              <Share /> 分享
            </Button>
          )}
          <Tooltip label="文件">
            <Button
              variant="ghost"
              size="icon"
              aria-label="文件"
              aria-pressed={panel?.kind === 'files'}
              className={cn('text-muted-foreground', panel?.kind === 'files' && 'bg-hover text-foreground')}
              onClick={() => setPanel(panel?.kind === 'files' ? null : { kind: 'files', path: null })}
            >
              <FolderOpen className="size-5!" />
            </Button>
          </Tooltip>
        </header>

        {temporary && (
          <div className={cn('mx-auto flex w-full shrink-0 items-center gap-2 px-4 pb-2 text-sm text-muted-foreground md:px-6', column)}>
            <Ghost className="size-4 shrink-0 text-accent" />
            <span className="min-w-0 flex-1">
              <span className="font-medium text-foreground">临时对话</span> · 不进历史、不读写记忆；离开这个页面或 24 小时后删除
            </span>
          </div>
        )}

        <div className="relative min-h-0 flex-1">
          <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto [scrollbar-gutter:stable_both-edges]">
            <div ref={content} className={cn('mx-auto flex w-full flex-col gap-10 px-4 pt-4 pb-12 md:px-6', column)}>
              {!loaded ? (
                <Loading />
              ) : empty ? (
                <p className="py-20 text-center text-sm text-muted-foreground">发一条消息开始对话。</p>
              ) : (
                turns.map((t, i) => <TurnView key={t.id} turn={t} ctx={ctx} last={i === turns.length - 1} />)
              )}
            </div>
          </div>
          {!panel && turns.length > 2 && <Outline turns={turns} scroller={scroller} />}
          {away && (
            <Button
              size="icon"
              aria-label="回到底部"
              onClick={() => toBottom(true)}
              className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-card shadow-float animate-in fade-in-0 slide-in-from-bottom-2"
            >
              <ArrowDown />
            </Button>
          )}
        </div>

        <div className={cn('mx-auto w-full shrink-0 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:px-6', column)}>
          {aside.card}
          <CompactionLine running={compaction.running} failure={compaction.failure} onRetry={() => client.compact(treeId)} />
          <Composer treeId={treeId} placeholder="回复…" onSend={send} busy={running} onStop={() => client.stop(treeId)} autoFocus={!phone} />
          {footnote}
        </div>
      </div>

      <ShareDialog open={sharing} onOpenChange={setSharing} treeId={treeId} title={tree?.title ?? ''} turns={turns} />

      {panel && (
        <aside
          aria-label={panel.kind === 'files' ? '文件' : '视图'}
          className={cn('flex h-full min-w-0 flex-col bg-background', phone ? 'absolute inset-0 z-20' : 'w-[min(48%,640px)] shrink-0 border-l')}
        >
          <SidePanel
            title={panel.kind === 'files' ? '文件' : (tools.get(panelCall?.name ?? '')?.title ?? '视图')}
            onClose={() => setPanel(null)}
            flush={panel.kind === 'files'}
          >
            {panel.kind === 'files' ? (
              <WorkspacePanel treeId={treeId} files={files} open={panel.path} onOpen={(path) => setPanel({ kind: 'files', path })} />
            ) : (
              panelCall && <PanelView treeId={treeId} call={panelCall} ctx={ctx} />
            )}
          </SidePanel>
        </aside>
      )}
    </div>
  )
}

function PanelView({ treeId, call, ctx }: { treeId: string; call: ToolCall; ctx: TurnContext }) {
  const meta = ctx.tools.get(call.name)
  if (!meta) return null
  return <ViewSlot treeId={treeId} call={call} meta={meta} displayMode="panel" onDisplayMode={(mode) => ctx.onDisplayMode(call, mode)} onSend={ctx.onSend} />
}

function SidePanel({ title, onClose, flush, children }: { title: string; onClose: () => void; flush?: boolean; children: ReactNode }) {
  return (
    <>
      <div className="flex h-13 shrink-0 items-center gap-2 border-b pr-2 pl-4">
        <strong className="min-w-0 flex-1 truncate text-sm">{title}</strong>
        <Tooltip label="关闭">
          <Button variant="ghost" size="icon-sm" aria-label="关闭面板" onClick={onClose}>
            <X />
          </Button>
        </Tooltip>
      </div>
      <div className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto', !flush && 'p-4')}>{children}</div>
    </>
  )
}

/** Ticks down the right edge, one per question; hovering names them, a click goes there. */
function Outline({ turns, scroller }: { turns: Turn[]; scroller: React.RefObject<HTMLDivElement | null> }) {
  const items = turns.flatMap((t) => (t.event || t.brief !== undefined || !t.userMessage.trim() ? [] : [t]))
  if (items.length < 3) return null
  const go = (id: string) => scroller.current?.querySelector(`[data-turn="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return (
    <nav aria-label="对话大纲" className="group/outline absolute top-1/2 right-2 z-10 hidden max-h-[70%] -translate-y-1/2 xl:block">
      <div className="flex flex-col items-end gap-2 px-2 py-3 group-hover/outline:invisible group-focus-within/outline:invisible">
        {items.slice(-24).map((t) => (
          <span key={t.id} className="h-0.5 w-3 rounded-full bg-input" />
        ))}
      </div>
      <ol className="invisible absolute top-1/2 right-0 flex max-h-[60dvh] w-64 -translate-y-1/2 flex-col overflow-y-auto rounded-2xl bg-popover p-1 opacity-0 shadow-pop transition-opacity group-hover/outline:visible group-hover/outline:opacity-100 group-focus-within/outline:visible group-focus-within/outline:opacity-100">
        <li className="px-2.5 pt-2 pb-1 text-xs text-muted-foreground">大纲 · {items.length} 个问题</li>
        {items.map((t) => (
          <li key={t.id}>
            <button type="button" onClick={() => go(t.id)} className="block w-full truncate rounded-lg px-2.5 py-1.5 text-left text-sm text-muted-foreground hover:bg-hover hover:text-foreground">
              {t.userMessage.trim().split('\n')[0]}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}

/**
 * Deletes a temporary chat when the user goes elsewhere in the app (B6). A reload keeps it, and the server deletes what
 * is left after 24 hours. Checked a tick later, so React's development remount does not count as leaving.
 */
function useLeaveTemporary(treeId: string, temporary: boolean) {
  const client = useClient()
  useEffect(() => {
    if (!temporary) return
    return () => {
      setTimeout(() => {
        if (location.pathname !== href({ name: 'chat', id: treeId })) client.request({ t: 'tree.delete', treeId }).catch(() => {})
      })
    }
  }, [client, treeId, temporary])
}

function ShareDialog({ open, onOpenChange, treeId, title, turns }: { open: boolean; onOpenChange: (v: boolean) => void; treeId: string; title: string; turns: Turn[] }) {
  const [copied, flash] = useFlash()
  const markdown = () => toMarkdown(title, turns)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="分享对话" description={`「${title || '新对话'}」 · ${turns.length} 轮`} className="sm:max-w-md">
        <DialogBody className="flex flex-col gap-2">
          <PublicLink treeId={treeId} title={title} turns={turns} />
          <button type="button" onClick={() => void copyText(markdown()).then((ok) => ok && flash())} className="flex items-center gap-3 rounded-xl border p-3 text-left transition-colors hover:bg-hover">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">{copied ? <Check className="size-4 text-accent" /> : <Copy className="size-4" />}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{copied ? '已复制' : '复制全文'}</span>
              <span className="block text-xs text-muted-foreground">Markdown 格式，含来源链接</span>
            </span>
          </button>
          <button type="button" onClick={() => saveBlob(`${title || '对话'}.md`, new Blob([markdown()], { type: 'text/markdown' }))} className="flex items-center gap-3 rounded-xl border p-3 text-left transition-colors hover:bg-hover">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
              <Download className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">下载为文件</span>
              <span className="block text-xs text-muted-foreground">保存一份 .md 到本机</span>
            </span>
          </button>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

/** A read-only page anyone with the link can open (roadmap-7 B1–B3): a snapshot, refreshed only when asked. */
function PublicLink({ treeId, title, turns }: { treeId: string; title: string; turns: Turn[] }) {
  const client = useClient()
  const tools = useTools()
  const share = useShares()?.find((s) => s.treeId === treeId)
  const [busy, setBusy] = useState<'create' | 'update' | 'delete' | null>(null)
  const [copied, flash] = useFlash()
  const url = share ? new URL(sharePath(share.token), location.origin).href : ''
  // Turns since the snapshot was taken, so "update" says what it would add.
  const newer = share ? turns.filter((t) => t.createdAt > share.updatedAt).length : 0

  const run = (kind: 'create' | 'update' | 'delete') => {
    setBusy(kind)
    const snapshot = () => buildSnapshot(title, turns, tools, (path) => client.request<{ mimeType: string; base64: string }>({ t: 'files.read', treeId, path }))
    const work =
      kind === 'delete'
        ? client.deleteShare(share!.token).then(() => toast('已停止分享，原链接不再能打开'))
        : snapshot()
            .then((snap) => (kind === 'create' ? client.createShare(treeId, snap) : client.updateShare(share!.token, snap)))
            .then((info) => copyText(new URL(sharePath(info.token), location.origin).href))
            .then((ok) => {
              if (ok) flash()
              toast.success(kind === 'create' ? '链接已创建并复制' : '链接已更新为最新内容', { description: kind === 'create' ? '之后的对话不会出现在链接里，需要时点「更新」。' : undefined })
            })
    work.then(
      () => setBusy(null),
      (e: unknown) => {
        setBusy(null)
        report(e)
      },
    )
  }

  if (!share)
    return (
      <div className="flex items-center gap-3 rounded-xl border p-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
          <Link2 className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">公开链接</span>
          <span className="block text-xs text-muted-foreground">拿到链接的人无需登录就能看到问答和生成的界面；看不到思考过程、工具细节和文件。</span>
        </span>
        <Button size="sm" variant="primary" disabled={!!busy} onClick={() => run('create')}>
          {busy ? <Spinner /> : null} 创建
        </Button>
      </div>
    )

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-accent/30 bg-accent-soft/40 p-3">
      <div className="flex items-center gap-2">
        <Globe className="size-4 shrink-0 text-accent" />
        <span className="text-sm font-medium">已公开分享</span>
        <span className="ml-auto text-xs text-muted-foreground">快照于 {formatTime(share.updatedAt)} · {share.turns} 轮</span>
      </div>
      <div className="flex gap-2">
        <Input readOnly value={url} aria-label="公开链接" onFocus={(e) => e.currentTarget.select()} className="h-9 font-mono text-xs" />
        <Button size="sm" className="h-9" onClick={() => void copyText(url).then((ok) => ok && flash())}>
          {copied ? <Check /> : <Copy />} {copied ? '已复制' : '复制'}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!!busy} onClick={() => run('update')}>
          {busy === 'update' ? <Spinner /> : <RefreshCw />} 更新为最新内容{newer > 0 ? `（新增 ${newer} 轮）` : ''}
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <a href={url} target="_blank" rel="noreferrer">
            <ExternalLink /> 打开
          </a>
        </Button>
        <Button size="sm" variant="ghost-destructive" disabled={!!busy} onClick={() => run('delete')} className="ml-auto">
          {busy === 'delete' ? <Spinner /> : null} 停止分享
        </Button>
      </div>
    </div>
  )
}

function Loading() {
  return (
    <div aria-busy className="flex flex-col gap-6 pt-2">
      <Skeleton className="ml-auto h-10 w-2/5 rounded-3xl" />
      <div className="flex flex-col gap-2.5">
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    </div>
  )
}

function TitleMenu({ treeId, title, pinned, temporary, canCompact, onExport }: { treeId: string; title: string; pinned: boolean; temporary: boolean; canCompact: boolean; onExport: () => void }) {
  const client = useClient()
  const projects = useProjects() ?? []
  const project = projectOf(projects, findTree(useHost(), treeId))
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [draft, setDraft] = useState('')

  const rename = () => {
    setRenaming(false)
    const next = draft.trim()
    if (next && next !== title) client.request({ t: 'tree.update', treeId, title: next }).catch(report)
  }

  return (
    <>
      {project && (
        <Link to={{ name: 'projects', id: project.id }} className="flex h-9 min-w-0 shrink items-center gap-1.5 rounded-lg px-2 text-sm text-muted-foreground hover:bg-hover hover:text-foreground max-sm:hidden">
          <span className="size-2 shrink-0 rounded-full" style={{ background: projectColors[project.color] }} />
          <span className="max-w-32 truncate">{project.name}</span>
          <span className="pl-1 opacity-50">/</span>
        </Link>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="min-w-0 shrink gap-1 px-2.5 text-[15px] font-medium">
            <span className="truncate">{title || '新对话'}</span>
            <ChevronDown className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            onSelect={() => {
              setDraft(title)
              setRenaming(true)
            }}
          >
            <Pencil /> 重命名
          </DropdownMenuItem>
          {!temporary && (
            <DropdownMenuItem onSelect={() => void client.request({ t: 'tree.update', treeId, pinned: !pinned }).catch(report)}>
              {pinned ? <PinOff /> : <Pin />} {pinned ? '取消置顶' : '置顶'}
            </DropdownMenuItem>
          )}
          {!temporary && projects.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="flex items-center gap-1.5">
                <FolderInput className="size-3.5" /> 移到项目
              </DropdownMenuLabel>
              {projects.map((p) => (
                <DropdownMenuCheckItem key={p.id} checked={project?.id === p.id} onSelect={() => client.moveToProject(treeId, project?.id === p.id ? null : p.id)}>
                  <span className="flex items-center gap-2">
                    <span className="size-2 rounded-full" style={{ background: projectColors[p.color] }} />
                    <span className="truncate">{p.name}</span>
                  </span>
                </DropdownMenuCheckItem>
              ))}
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onExport}>
            <Download /> 导出 Markdown
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canCompact} onSelect={() => client.compact(treeId)}>
            <Minimize2 /> 压缩上下文
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => setDeleting(true)}>
            <Trash2 /> 删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent title="重命名对话" className="sm:max-w-md">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              rename()
            }}
          >
            <DialogBody className="pb-4">
              <Input autoFocus aria-label="标题" value={draft} maxLength={200} onChange={(e) => setDraft(e.target.value)} onFocus={(e) => e.target.select()} />
            </DialogBody>
            <DialogFooter>
              <Button type="button" onClick={() => setRenaming(false)}>
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={!draft.trim()}>
                保存
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="删除这个对话？"
        confirm="删除"
        onConfirm={() =>
          void client.request({ t: 'tree.delete', treeId }).then(() => {
            navigate({ name: 'home' }, { replace: true })
          }, report)
        }
      >
        对话的所有分支、文件和它的定时任务都会删除，不能恢复。
      </ConfirmDialog>
    </>
  )
}
