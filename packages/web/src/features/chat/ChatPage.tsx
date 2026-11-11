import { ArrowDown, ChevronDown, FolderOpen, GitBranch, Pencil, Pin, PinOff, Radio, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { report, useChat, useClient, useFiles, useHost, useTools } from '../../app/client'
import { SidebarToggle } from '../../app/Shell'
import { phoneQuery } from '../../app/shell-context'
import { cn } from '../../lib/cn'
import { useMediaQuery } from '../../lib/hooks'
import { navigate } from '../../lib/router'
import type { Outgoing, ToolCall } from '../../lib/types'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter } from '../../ui/dialog'
import { Skeleton } from '../../ui/feedback'
import { Input } from '../../ui/input'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../../ui/menu'
import { Tooltip } from '../../ui/tooltip'
import { BranchMap, branchName } from './BranchMap'
import { compactCommand } from '../../lib/commands'
import { CompactionLine } from './Compaction'
import { Composer } from './Composer'
import { footnote } from './HomePage'
import { TurnView, type TurnContext } from './Turn'
import { ViewSlot } from './ViewSlot'
import { WorkspacePanel } from './WorkspacePanel'

/** What the side panel holds: one call's view, or the conversation's files. */
type Panel = { kind: 'view'; callId: string } | { kind: 'files'; path: string | null }

const NEAR_BOTTOM = 80

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
  const { tree, loaded, turns, branches, branch, running, entryCount, compaction } = useChat(treeId)
  const [panel, setPanel] = useState<Panel | null>(null)
  const files = useFiles(treeId, panel?.kind === 'files', entryCount)
  const { scroller, content, away, toBottom, onScroll } = useFollow(loaded)

  const send = useCallback(
    (message: Outgoing) => {
      toBottom()
      // `/压缩上下文` runs here; what was typed with it says what the summary should keep.
      if (message.command?.id === compactCommand.id) client.compact(treeId, message.text)
      else client.send(treeId, message).catch(report)
    },
    [client, treeId, toBottom],
  )

  const ctx = useMemo<TurnContext>(
    () => ({
      treeId,
      tools,
      models,
      busy: running,
      onRegenerate: (turn) => client.regenerate(treeId, turn),
      onEdit: (turn, text) => client.edit(treeId, turn, text),
      onFork: (turn) => client.fork(treeId, turn),
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

  const main = branches?.branches.find((b) => b.role === 'main')
  const onSide = branch && branch.role !== 'main'
  const empty = loaded && turns.length === 0

  return (
    <div className="relative flex h-full min-w-0">
      <div className={cn('flex h-full min-w-0 flex-1 flex-col', panel && phone && 'hidden')}>
        <header className="flex h-13 shrink-0 items-center gap-1 px-2 md:px-3">
          <SidebarToggle />
          <TitleMenu treeId={treeId} title={tree?.title ?? ''} pinned={!!tree?.pinned} />
          {tree?.source && (
            <Badge variant="outline" className="max-sm:hidden">
              <Radio /> {tree.source.label || tree.source.kind}
            </Badge>
          )}
          <span className="flex-1" />
          {branches && branch && <BranchMap state={branches} shown={branch.id} onShow={(id) => client.showBranch(treeId, id)} />}
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

        {onSide && (
          <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-wrap items-center gap-2 px-4 pb-2 text-sm md:px-6">
            <GitBranch className="size-4 shrink-0 text-accent" />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {branch.role === 'agent' ? '子代理分支' : '分叉'}：<span className="text-foreground">{branchName(branch)}</span>
            </span>
            {branch.role === 'user' && (
              <Tooltip label="让这个分叉总结自己，并把结论报告给主线">
                <Button size="sm" disabled={running || turns.length === 0} onClick={() => client.summarize(treeId)}>
                  总结给主线
                </Button>
              </Tooltip>
            )}
            {main && (
              <Button size="sm" onClick={() => client.showBranch(treeId, main.id)}>
                返回主线
              </Button>
            )}
          </div>
        )}

        <div className="relative min-h-0 flex-1">
          <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto [scrollbar-gutter:stable_both-edges]">
            <div ref={content} className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 pt-4 pb-10 md:px-6">
              {!loaded ? (
                <Loading />
              ) : empty ? (
                <p className="py-16 text-center text-sm text-muted-foreground">{onSide ? '这个分叉还没有消息。从这里问点别的，主线不受影响。' : '发一条消息开始对话。'}</p>
              ) : (
                turns.map((t) => <TurnView key={t.id} turn={t} ctx={ctx} />)
              )}
            </div>
          </div>
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

        <div className="mx-auto w-full max-w-3xl shrink-0 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:px-6">
          <CompactionLine running={compaction.running} failure={compaction.failure} onRetry={() => client.compact(treeId)} />
          <Composer treeId={treeId} placeholder={onSide ? '在这个分叉里继续…' : '回复…'} onSend={send} busy={running} onStop={() => client.stop(treeId)} autoFocus={!phone} />
          {footnote}
        </div>
      </div>

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

function TitleMenu({ treeId, title, pinned }: { treeId: string; title: string; pinned: boolean }) {
  const client = useClient()
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
          <DropdownMenuItem onSelect={() => void client.request({ t: 'tree.update', treeId, pinned: !pinned }).catch(report)}>
            {pinned ? <PinOff /> : <Pin />} {pinned ? '取消置顶' : '置顶'}
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
          void client.request({ t: 'tree.delete', treeId }).then(() => navigate({ name: 'home' }, { replace: true }), report)
        }
      >
        对话的所有分支、文件和它的定时任务都会删除，不能恢复。
      </ConfirmDialog>
    </>
  )
}
