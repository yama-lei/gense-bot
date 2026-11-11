import type { TreeMeta } from '@gense/protocol'
import { Blocks, Ellipsis, MessageCircle, PanelLeftClose, Pencil, Pin, PinOff, Radio, Search, Settings, ShieldCheck, SquarePen, Timer, Trash2 } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { cn } from '../lib/cn'
import { dayGroup } from '../lib/format'
import { modKey } from '../lib/hooks'
import { Link, navigate, useRoute, type Route } from '../lib/router'
import { Button } from '../ui/button'
import { ConfirmDialog } from '../ui/dialog'
import { Skeleton } from '../ui/feedback'
import { Logo } from '../ui/logo'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/menu'
import { Tooltip } from '../ui/tooltip'
import { report, useClient, useHost, useUser } from './client'
import { useShell } from './shell-context'

const row = 'flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm outline-offset-[-2px] hover:bg-hover'

function NavLink({ to, active, icon, children, hint }: { to: Route; active?: boolean; icon: ReactNode; children: ReactNode; hint?: string }) {
  return (
    <Link to={to} aria-current={active ? 'page' : undefined} className={cn(row, '[&_svg]:size-4.5 [&_svg]:shrink-0', active && 'bg-hover font-medium')}>
      {icon}
      <span className="flex-1 truncate">{children}</span>
      {hint && <kbd className="text-xs text-muted-foreground max-md:hidden">{hint}</kbd>}
    </Link>
  )
}

/** Conversations in the sidebar's order: pinned first, then by day, newest first. */
function grouped(trees: TreeMeta[]) {
  const groups: { label: string; items: TreeMeta[] }[] = []
  const sorted = [...trees].sort((a, b) => b.updatedAt - a.updatedAt)
  const pinned = sorted.filter((t) => t.pinned)
  if (pinned.length) groups.push({ label: '置顶', items: pinned })
  for (const t of sorted) {
    if (t.pinned) continue
    const label = dayGroup(t.updatedAt)
    if (groups.at(-1)?.label === label) groups.at(-1)!.items.push(t)
    else groups.push({ label, items: [t] })
  }
  return groups
}

function ConversationItem({ tree, active, onNavigate }: { tree: TreeMeta; active: boolean; onNavigate: () => void }) {
  const client = useClient()
  const [renaming, setRenaming] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const title = tree.title || '新对话'

  const rename = (value: string) => {
    setRenaming(false)
    const next = value.trim()
    if (next && next !== tree.title) client.request({ t: 'tree.update', treeId: tree.id, title: next }).catch(report)
  }

  if (renaming)
    return (
      <input
        autoFocus
        defaultValue={tree.title}
        aria-label="对话标题"
        maxLength={120}
        onFocus={(e) => e.target.select()}
        onBlur={(e) => rename(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') rename(e.currentTarget.value)
          if (e.key === 'Escape') setRenaming(false)
        }}
        className="h-9 w-full rounded-lg border border-ring bg-card px-2.5 text-sm outline-none"
      />
    )

  return (
    <div className={cn('group/item relative rounded-lg hover:bg-hover has-[[data-state=open]]:bg-hover', active && 'bg-hover')}>
      <Link to={{ name: 'chat', id: tree.id }} onClick={onNavigate} aria-current={active ? 'page' : undefined} title={title} className={cn(row, 'pr-9 hover:bg-transparent', active && 'font-medium')}>
        {tree.source && (
          <Tooltip label={`来自${tree.source.kind === 'feishu' ? '飞书' : tree.source.kind}：${tree.source.label}`} side="right">
            <MessageCircle className="size-3.5 shrink-0 text-accent" aria-label="来自机器人渠道" />
          </Tooltip>
        )}
        <span className="truncate">{title}</span>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`「${title}」的更多操作`}
            className="absolute top-1 right-1 opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
          >
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            <Pencil /> 重命名
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => client.request({ t: 'tree.update', treeId: tree.id, pinned: !tree.pinned }).catch(report)}>
            {tree.pinned ? <PinOff /> : <Pin />} {tree.pinned ? '取消置顶' : '置顶'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => setConfirming(true)}>
            <Trash2 /> 删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="删除这个对话？"
        confirm="删除"
        onConfirm={() => {
          if (active) navigate({ name: 'home' }, { replace: true })
          client.request({ t: 'tree.delete', treeId: tree.id }).catch(report)
        }}
      >
        「{title}」和它的分支、工作区文件、定时任务都会删除，无法恢复。
      </ConfirmDialog>
    </div>
  )
}

/** `onNavigate` closes the drawer on a phone; `onCollapse` is there only on a desktop. */
export function Sidebar({ onNavigate, onCollapse }: { onNavigate: () => void; onCollapse?: () => void }) {
  const route = useRoute()
  const host = useHost()
  const { openPalette } = useShell()
  const user = useUser()
  const groups = useMemo(() => grouped(host.trees ?? []), [host.trees])

  return (
    <nav aria-label="侧边栏" className="flex h-full flex-col bg-sidebar pt-[env(safe-area-inset-top)]">
      <div className="flex h-13 shrink-0 items-center justify-between pr-2 pl-4">
        <Link to={{ name: 'home' }} onClick={onNavigate} className="flex items-center gap-2 rounded-md font-serif text-lg">
          <Logo className="size-5.5" /> GenseBot
        </Link>
        {onCollapse && (
          <Tooltip label="收起侧边栏">
            <Button variant="ghost" size="icon-sm" aria-label="收起侧边栏" onClick={onCollapse} className="text-muted-foreground">
              <PanelLeftClose />
            </Button>
          </Tooltip>
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-0.5 px-2 pb-2" onClick={(e) => (e.target as HTMLElement).closest('a') && onNavigate()}>
        <NavLink to={{ name: 'home' }} icon={<SquarePen />} hint={`${modKey}⇧O`}>
          新对话
        </NavLink>
        <button type="button" onClick={openPalette} className={cn(row, 'text-left [&_svg]:size-4.5')}>
          <Search />
          <span className="flex-1">搜索</span>
          <kbd className="text-xs text-muted-foreground max-md:hidden">{modKey}K</kbd>
        </button>
        <NavLink to={{ name: 'plugins' }} active={route.name === 'plugins'} icon={<Blocks />}>
          插件与 Skill
        </NavLink>
        <NavLink to={{ name: 'automations' }} active={route.name === 'automations'} icon={<Timer />}>
          自动化
        </NavLink>
        <NavLink to={{ name: 'channels' }} active={route.name === 'channels'} icon={<Radio />}>
          机器人渠道
        </NavLink>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {host.trees === null ? (
          <div className="flex flex-col gap-2 px-2.5 pt-4" aria-label="正在加载对话">
            {['w-3/4', 'w-1/2', 'w-5/6', 'w-3/5', 'w-2/5'].map((w) => (
              <Skeleton key={w} className={cn('h-4', w)} />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <p className="px-2.5 pt-4 text-sm text-muted-foreground">还没有对话。发一条消息，它会出现在这里。</p>
        ) : (
          groups.map((g) => (
            <section key={g.label} aria-label={g.label} className="pt-3">
              <h2 className="px-2.5 pb-1 text-xs text-muted-foreground">{g.label}</h2>
              <div className="flex flex-col gap-px">
                {g.items.map((t) => (
                  <ConversationItem key={t.id} tree={t} active={route.name === 'chat' && route.id === t.id} onNavigate={onNavigate} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      <div className="shrink-0 border-t px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]" onClick={(e) => (e.target as HTMLElement).closest('a') && onNavigate()}>
        {user.role === 'admin' && (
          <NavLink to={{ name: 'admin' }} active={route.name === 'admin'} icon={<ShieldCheck />}>
            管理后台
          </NavLink>
        )}
        <NavLink to={{ name: 'settings' }} active={route.name === 'settings'} icon={<Settings />}>
          设置
        </NavLink>
      </div>
    </nav>
  )
}
