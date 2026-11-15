import type { TreeHit } from '@gense/protocol'
import { projectColors } from '../lib/lab'
import { Command } from 'cmdk'
import { Blocks, BookMarked, Brain, CornerDownLeft, Cpu, FolderClosed, Inbox, Keyboard, MessageSquare, Monitor, Moon, PanelLeft, Radio, Search, Settings, SquarePen, Sun, TextSearch, Timer } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { formatTime } from '../lib/format'
import { navigate, type Route } from '../lib/router'
import { accentPref, accents, themePref } from '../lib/theme'
import { Spinner } from '../ui/feedback'
import { localPrefs, useClient, useHost, useProjects } from './client'

const itemClass =
  'flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm data-[selected=true]:bg-hover [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground'
const kbdClass = 'grid h-5 min-w-5 place-items-center rounded border bg-muted px-1 font-sans text-[11px]'
const groupClass = '[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground'

const pages: { label: string; keywords: string; icon: ReactNode; to: Route }[] = [
  { label: '新对话', keywords: 'new chat xinduihua', icon: <SquarePen />, to: { name: 'home' } },
  { label: '收件箱', keywords: 'inbox shoujianxiang', icon: <Inbox />, to: { name: 'inbox' } },
  { label: '项目', keywords: 'projects xiangmu', icon: <FolderClosed />, to: { name: 'projects' } },
  { label: '资料库', keywords: 'library files ziliaoku wenjian', icon: <BookMarked />, to: { name: 'library' } },
  { label: '记忆', keywords: 'memory jiyi', icon: <Brain />, to: { name: 'memory' } },
  { label: '插件与 Skill', keywords: 'plugins mcp skills chajian', icon: <Blocks />, to: { name: 'plugins' } },
  { label: '自动化', keywords: 'automations schedule webhook dingshi', icon: <Timer />, to: { name: 'automations' } },
  { label: '机器人渠道', keywords: 'channels feishu bot feishu', icon: <Radio />, to: { name: 'channels' } },
  { label: '设置', keywords: 'settings shezhi', icon: <Settings />, to: { name: 'settings' } },
  { label: '模型账户', keywords: 'models api key moxing', icon: <Cpu />, to: { name: 'settings', section: 'models' } },
  { label: '快捷键', keywords: 'shortcuts keyboard kuaijiejian', icon: <Keyboard />, to: { name: 'settings', section: 'shortcuts' } },
]
const themes = [
  { label: '主题：跟随系统', value: 'system', icon: <Monitor /> },
  { label: '主题：浅色', value: 'light', icon: <Sun /> },
  { label: '主题：深色', value: 'dark', icon: <Moon /> },
] as const

/** ⌘K (roadmap-5 N44): go to a page or project, open a conversation by title, search what was said, or change how things look. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const host = useHost()
  const client = useClient()
  const projects = useProjects() ?? []
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<{ query: string; items: TreeHit[] } | null>(null)
  const q = query.trim().toLowerCase()

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  // Message search runs on the server, a moment after typing stops.
  useEffect(() => {
    if (q.length < 2) return setHits(null)
    let live = true
    const timer = setTimeout(() => {
      client.request<TreeHit[]>({ t: 'trees.search', query: q, limit: 12 }).then(
        (items) => live && setHits({ query: q, items }),
        () => live && setHits({ query: q, items: [] }),
      )
    }, 220)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [client, q])

  const go = (to: Route) => {
    onOpenChange(false)
    navigate(to)
  }
  const match = (text: string) => !q || text.toLowerCase().includes(q)
  const trees = [...(host.trees ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)
  const byTitle = trees.filter((t) => match(t.title || '新对话')).slice(0, q ? 8 : 6)
  // Before anything is typed: the places gone to most, so recent conversations stay in view.
  const shownPages = q ? pages.filter((p) => match(p.label) || match(p.keywords)) : pages.slice(0, 5)
  const shownProjects = q ? projects.filter((p) => match(p.name)).slice(0, 5) : []
  const shownAccents = q ? accents.filter((a) => match(`强调色：${a.label}`) || 'accent color'.includes(q)) : []
  const showSidebar = !!q && (match('收起或展开侧栏') || 'sidebar'.includes(q))
  const shownThemes = q ? themes.filter((t) => match(t.label) || 'theme'.includes(q)) : []
  const searching = q.length >= 2 && hits?.query !== q
  const found = hits?.query === q ? hits.items : []

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="搜索与命令"
      shouldFilter={false}
      loop
      overlayClassName="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0"
      contentClassName="fixed top-[12dvh] left-1/2 z-50 flex max-h-[min(70dvh,560px)] w-[min(92vw,600px)] -translate-x-1/2 flex-col overflow-hidden rounded-2xl bg-popover shadow-pop outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-97"
    >
      <div className="flex items-center gap-3 border-b px-4">
        <Search className="size-4.5 shrink-0 text-muted-foreground" />
        <Command.Input value={query} onValueChange={setQuery} placeholder="搜索对话，或输入命令…" className="h-13 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground" />
        {searching && <Spinner />}
      </div>
      <Command.List className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {!searching && <Command.Empty className="px-3 py-8 text-center text-sm text-muted-foreground">没有找到「{query.trim()}」</Command.Empty>}
        {shownPages.length > 0 && (
          <Command.Group heading="前往" className={groupClass}>
            {shownPages.map((p) => (
              <Command.Item key={p.label} value={`page:${p.label}`} onSelect={() => go(p.to)} className={itemClass}>
                {p.icon} {p.label}
              </Command.Item>
            ))}
          </Command.Group>
        )}
        {shownProjects.length > 0 && (
          <Command.Group heading="项目" className={groupClass}>
            {shownProjects.map((p) => (
              <Command.Item key={p.id} value={`project:${p.id}`} onSelect={() => go({ name: 'projects', id: p.id })} className={itemClass}>
                <FolderClosed style={{ color: projectColors[p.color] }} /> <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{trees.filter((t) => t.projectId === p.id).length} 个对话</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
        {byTitle.length > 0 && (
          <Command.Group heading={q ? '对话' : '最近的对话'} className={groupClass}>
            {byTitle.map((t) => (
              <Command.Item key={t.id} value={`tree:${t.id}`} onSelect={() => go({ name: 'chat', id: t.id })} className={itemClass}>
                <MessageSquare />
                <span className="min-w-0 flex-1 truncate">{t.title || '新对话'}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{formatTime(t.updatedAt)}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
        {found.length > 0 && (
          <Command.Group heading="消息内容" className={groupClass}>
            {found.map((h) => (
              <Command.Item key={h.treeId} value={`hit:${h.treeId}`} onSelect={() => go({ name: 'chat', id: h.treeId })} className={itemClass}>
                <TextSearch className="self-start mt-0.5" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{h.title || '新对话'}</span>
                  <span className="line-clamp-2 text-xs text-muted-foreground">{h.snippet}</span>
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
        {(shownThemes.length > 0 || shownAccents.length > 0 || showSidebar) && (
          <Command.Group heading="外观" className={groupClass}>
            {showSidebar && (
              <Command.Item
                value="sidebar"
                onSelect={() => {
                  localPrefs.set((p) => ({ ...p, sidebar: !p.sidebar }))
                  onOpenChange(false)
                }}
                className={itemClass}
              >
                <PanelLeft /> 收起或展开侧栏
              </Command.Item>
            )}
            {shownAccents.map((a) => (
              <Command.Item
                key={a.id}
                value={`accent:${a.id}`}
                onSelect={() => {
                  accentPref.set(a.id)
                  onOpenChange(false)
                }}
                className={itemClass}
              >
                <span className="size-4 shrink-0 rounded-full" style={{ background: a.swatch }} /> 强调色：{a.label}
              </Command.Item>
            ))}
            {shownThemes.map((t) => (
              <Command.Item
                key={t.value}
                value={`theme:${t.value}`}
                onSelect={() => {
                  themePref.set(t.value)
                  onOpenChange(false)
                }}
                className={itemClass}
              >
                {t.icon} {t.label}
              </Command.Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
      <div className="flex h-9 shrink-0 items-center gap-4 border-t px-4 text-xs text-muted-foreground max-sm:hidden">
        <span className="flex items-center gap-1.5">
          <kbd className={kbdClass}>↑</kbd>
          <kbd className={kbdClass}>↓</kbd> 选择
        </span>
        <span className="flex items-center gap-1.5">
          <kbd className={kbdClass}>
            <CornerDownLeft className="size-3" />
          </kbd>
          打开
        </span>
        <span className="flex items-center gap-1.5">
          <kbd className={kbdClass}>Esc</kbd> 关闭
        </span>
        <span className="flex-1" />
        输入两个字以上会搜索消息内容
      </div>
    </Command.Dialog>
  )
}
