import type { TreeMeta } from '@gense/protocol'
import {
  Blocks,
  BookMarked,
  Brain,
  ChevronDown,
  ChevronsUpDown,
  Ellipsis,
  FolderClosed,
  FolderInput,
  Inbox,
  Keyboard,
  LogOut,
  MessageCircle,
  Monitor,
  Moon,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Radio,
  Search,
  Settings,
  ShieldCheck,
  SquarePen,
  Sun,
  Timer,
  Trash2,
} from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { useInbox } from '../features/inbox/items'
import { cn } from '../lib/cn'
import { dayGroup } from '../lib/format'
import { modKey } from '../lib/hooks'
import { moveToProject, projectColors, projectOf, useProjects, type Project } from '../lib/lab'
import { Link, navigate, useRoute, type Route } from '../lib/router'
import { themePref, useThemePref, type ThemePref } from '../lib/theme'
import { Avatar } from '../ui/avatar'
import { Button } from '../ui/button'
import { ConfirmDialog } from '../ui/dialog'
import { Skeleton } from '../ui/feedback'
import { Logo } from '../ui/logo'
import { DropdownMenu, DropdownMenuCheckItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/menu'
import { Tooltip } from '../ui/tooltip'
import { localPrefs, report, useClient, useHost, useLocalPrefs, useUser } from './client'
import { useShell } from './shell-context'

const row = 'flex h-8.5 items-center gap-2.5 rounded-lg px-2.5 text-sm outline-offset-[-2px] transition-colors hover:bg-hover'

interface Nav {
  to: Route
  label: string
  icon: ReactNode
  name: Route['name']
}

const workNav: Nav[] = [
  { to: { name: 'inbox' }, label: '收件箱', icon: <Inbox />, name: 'inbox' },
  { to: { name: 'projects' }, label: '项目', icon: <FolderClosed />, name: 'projects' },
  { to: { name: 'library' }, label: '资料库', icon: <BookMarked />, name: 'library' },
]
const agentNav: Nav[] = [
  { to: { name: 'memory' }, label: '记忆', icon: <Brain />, name: 'memory' },
  { to: { name: 'plugins' }, label: '插件与 Skill', icon: <Blocks />, name: 'plugins' },
  { to: { name: 'automations' }, label: '自动化', icon: <Timer />, name: 'automations' },
  { to: { name: 'channels' }, label: '渠道', icon: <Radio />, name: 'channels' },
]

function NavLink({ nav, active, count }: { nav: Nav; active: boolean; count?: number }) {
  return (
    <Link to={nav.to} aria-current={active ? 'page' : undefined} className={cn(row, 'text-foreground/85 [&_svg]:size-4.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground', active && 'bg-hover font-medium text-foreground [&_svg]:text-foreground')}>
      {nav.icon}
      <span className="flex-1 truncate">{nav.label}</span>
      {!!count && <span className="rounded-full bg-accent px-1.5 text-[11px] leading-4.5 font-semibold text-accent-foreground tabular-nums">{count > 99 ? '99+' : count}</span>}
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

function ConversationItem({ tree, active, project, projects, onNavigate }: { tree: TreeMeta; active: boolean; project?: Project; projects: Project[]; onNavigate: () => void }) {
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
        className="h-8.5 w-full rounded-lg border border-ring bg-card px-2.5 text-sm outline-none"
      />
    )

  return (
    <div className={cn('group/item relative rounded-lg hover:bg-hover has-[[data-state=open]]:bg-hover', active && 'bg-card shadow-float hover:bg-card')}>
      <Link to={{ name: 'chat', id: tree.id }} onClick={onNavigate} aria-current={active ? 'page' : undefined} title={title} className={cn(row, 'pr-8 text-foreground/85 hover:bg-transparent', active && 'font-medium text-foreground')}>
        {tree.source ? (
          <Tooltip label={`来自${tree.source.kind === 'feishu' ? '飞书' : tree.source.kind}：${tree.source.label}`} side="right">
            <MessageCircle className="size-3.5 shrink-0 text-accent" aria-label="来自渠道" />
          </Tooltip>
        ) : (
          project && <span aria-label={`项目：${project.name}`} title={project.name} className="size-2 shrink-0 rounded-full" style={{ background: projectColors[project.color] }} />
        )}
        <span className="truncate">{title}</span>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`「${title}」的更多操作`}
            className="absolute top-[3px] right-1 opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
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
          {projects.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="flex items-center gap-1.5">
                <FolderInput className="size-3.5" /> 移到项目
              </DropdownMenuLabel>
              {projects.map((p) => (
                <DropdownMenuCheckItem key={p.id} checked={project?.id === p.id} onSelect={() => moveToProject(tree.id, project?.id === p.id ? null : p.id)}>
                  <span className="flex items-center gap-2">
                    <span className="size-2 rounded-full" style={{ background: projectColors[p.color] }} />
                    <span className="truncate">{p.name}</span>
                  </span>
                </DropdownMenuCheckItem>
              ))}
            </>
          )}
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
          moveToProject(tree.id, null)
          client.request({ t: 'tree.delete', treeId: tree.id }).catch(report)
        }}
      >
        「{title}」和它的分支、工作区文件、定时任务都会删除，无法恢复。
      </ConfirmDialog>
    </div>
  )
}

const themeItems: { id: ThemePref; label: string; icon: ReactNode }[] = [
  { id: 'system', label: '跟随系统', icon: <Monitor /> },
  { id: 'light', label: '浅色', icon: <Sun /> },
  { id: 'dark', label: '深色', icon: <Moon /> },
]

/** The account at the foot of the sidebar: who is signed in, and the way to settings, theme and sign-out. */
function AccountMenu({ rail, onNavigate }: { rail?: boolean; onNavigate: () => void }) {
  const user = useUser()
  const client = useClient()
  const { prefs } = useHost()
  const theme = useThemePref()
  const name = prefs?.name.trim() || user.email.split('@')[0]!
  const go = (to: Route) => {
    onNavigate()
    navigate(to)
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="账户菜单"
        className={cn('flex items-center gap-2.5 rounded-xl text-left outline-offset-[-2px] transition-colors hover:bg-hover data-[state=open]:bg-hover', rail ? 'size-10 justify-center' : 'h-12 w-full px-2')}
      >
        <Avatar name={name} className={rail ? 'size-7' : 'size-8 text-sm'} />
        {!rail && (
          <>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-sm font-medium">{name}</span>
              <span className="block truncate text-xs text-muted-foreground">{user.role === 'admin' ? '管理员' : '个人版'}</span>
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-64">
        <div className="px-2.5 pt-2 pb-1.5">
          <div className="truncate text-sm font-medium">{name}</div>
          <div className="truncate text-xs text-muted-foreground">{user.email}</div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => go({ name: 'settings' })}>
          <Settings /> 设置
          <kbd className="ml-auto text-xs text-muted-foreground">{modKey} ,</kbd>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => go({ name: 'settings', section: 'shortcuts' })}>
          <Keyboard /> 键盘快捷键
          <kbd className="ml-auto text-xs text-muted-foreground">{modKey} /</kbd>
        </DropdownMenuItem>
        {user.role === 'admin' && (
          <DropdownMenuItem onSelect={() => go({ name: 'admin' })}>
            <ShieldCheck /> 管理后台
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <div role="radiogroup" aria-label="主题" className="mx-1.5 my-1 grid grid-cols-3 gap-0.5 rounded-lg bg-muted p-0.5">
          {themeItems.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={theme === t.id}
              aria-label={t.label}
              title={t.label}
              onClick={() => themePref.set(t.id)}
              className={cn('grid h-7 place-items-center rounded-md text-muted-foreground [&_svg]:size-4', theme === t.id && 'bg-card text-foreground shadow-float')}
            >
              {t.icon}
            </button>
          ))}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void client.logout()}>
          <LogOut /> 退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function RailButton({ label, hint, active, count, onClick, to, children }: { label: string; hint?: string; active?: boolean; count?: number; onClick?: () => void; to?: Route; children: ReactNode }) {
  const className = cn(
    'relative grid size-10 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-hover hover:text-foreground [&_svg]:size-5',
    active && 'bg-card text-foreground shadow-float hover:bg-card',
  )
  const dot = !!count && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-accent ring-2 ring-sidebar" />
  return (
    <Tooltip
      side="right"
      label={
        <>
          {label}
          {hint && <span className="ml-2 opacity-60">{hint}</span>}
        </>
      }
    >
      {to ? (
        <Link to={to} aria-label={label} aria-current={active ? 'page' : undefined} className={className}>
          {children}
          {dot}
        </Link>
      ) : (
        <button type="button" aria-label={label} onClick={onClick} className={className}>
          {children}
          {dot}
        </button>
      )}
    </Tooltip>
  )
}

/**
 * `rail` is the collapsed desktop form: icons only. `onNavigate` closes the drawer on a phone; `onToggle` (desktop)
 * switches between the two forms.
 */
export function Sidebar({ rail, onNavigate, onToggle }: { rail?: boolean; onNavigate: () => void; onToggle?: () => void }) {
  const route = useRoute()
  const host = useHost()
  const { openPalette } = useShell()
  const { nav } = useLocalPrefs()
  const projects = useProjects()
  const { unread } = useInbox()
  const groups = useMemo(() => grouped(host.trees ?? []), [host.trees])

  if (rail)
    return (
      <nav aria-label="侧边栏" className="flex h-full w-14 flex-col items-center gap-1 py-2">
        <RailButton label="展开侧边栏" hint={`${modKey} B`} onClick={onToggle}>
          <Logo className="size-6!" />
        </RailButton>
        <RailButton label="新对话" hint={`${modKey} ⇧ O`} to={{ name: 'home' }} active={route.name === 'home'}>
          <SquarePen />
        </RailButton>
        <RailButton label="搜索" hint={`${modKey} K`} onClick={openPalette}>
          <Search />
        </RailButton>
        <span className="my-1 h-px w-6 bg-border" />
        {[...workNav, ...agentNav].map((n) => (
          <RailButton key={n.name} label={n.label} to={n.to} active={route.name === n.name} count={n.name === 'inbox' ? unread : 0}>
            {n.icon}
          </RailButton>
        ))}
        <span className="flex-1" />
        <AccountMenu rail onNavigate={onNavigate} />
      </nav>
    )

  return (
    <nav aria-label="侧边栏" className="flex h-full w-full flex-col bg-sidebar pt-[env(safe-area-inset-top)] md:w-70">
      <div className="flex h-13 shrink-0 items-center justify-between pr-2 pl-3.5">
        <Link to={{ name: 'home' }} onClick={onNavigate} className="flex items-center gap-2 rounded-md text-[17px] font-semibold tracking-tight">
          <Logo className="size-6" /> Gense
        </Link>
        {onToggle && (
          <Tooltip label={`收起侧边栏 · ${modKey} B`}>
            <Button variant="ghost" size="icon-sm" aria-label="收起侧边栏" onClick={onToggle} className="text-muted-foreground">
              <PanelLeft />
            </Button>
          </Tooltip>
        )}
      </div>

      <div className="flex shrink-0 gap-1.5 px-2.5 pb-2">
        <Link
          to={{ name: 'home' }}
          onClick={onNavigate}
          className="flex h-9.5 min-w-0 flex-1 items-center gap-2 rounded-xl bg-card px-3 text-sm font-medium shadow-float ring-1 ring-border transition-shadow hover:ring-input"
        >
          <SquarePen className="size-4 shrink-0 text-accent" />
          <span className="flex-1">新对话</span>
          <kbd className="text-[11px] font-normal text-muted-foreground max-md:hidden">{modKey}⇧O</kbd>
        </Link>
        <Tooltip label={`搜索 · ${modKey} K`}>
          <button type="button" aria-label="搜索" onClick={openPalette} className="grid size-9.5 shrink-0 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-hover hover:text-foreground">
            <Search className="size-4.5" />
          </button>
        </Tooltip>
      </div>

      <div className="flex shrink-0 flex-col gap-px px-2.5" onClick={(e) => (e.target as HTMLElement).closest('a') && onNavigate()}>
        {workNav.map((n) => (
          <NavLink key={n.name} nav={n} active={route.name === n.name} count={n.name === 'inbox' ? unread : 0} />
        ))}
        <button
          type="button"
          aria-expanded={nav}
          onClick={() => localPrefs.set((p) => ({ ...p, nav: !p.nav }))}
          className="mt-2 flex h-6 items-center gap-1 rounded-md px-2.5 text-xs text-muted-foreground hover:text-foreground"
        >
          智能体
          <ChevronDown className={cn('size-3 transition-transform', !nav && '-rotate-90')} />
        </button>
        {nav && agentNav.map((n) => <NavLink key={n.name} nav={n} active={route.name === n.name} />)}
      </div>

      <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-2.5 pb-2 [mask-image:linear-gradient(to_bottom,transparent,black_12px,black_calc(100%-12px),transparent)]">
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
              <h2 className="flex items-center gap-1 px-2.5 pb-1 text-xs text-muted-foreground">
                {g.label === '置顶' && <Pin className="size-3" />}
                {g.label}
              </h2>
              <div className="flex flex-col gap-px">
                {g.items.map((t) => (
                  <ConversationItem key={t.id} tree={t} active={route.name === 'chat' && route.id === t.id} project={projectOf(projects, t.id)} projects={projects} onNavigate={onNavigate} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      <div className="shrink-0 px-2 pt-1 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <AccountMenu onNavigate={onNavigate} />
      </div>
    </nav>
  )
}

