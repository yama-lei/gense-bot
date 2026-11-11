// Plugins (built-in tools and MCP servers) and Skills (Agent Skills folders), as installed and as offered in the
// Discover catalog (roadmap-6 B1–B6). This file is the layout and the actions; cards, detail and forms are beside it.
import type { DiscoverItem, PluginInfo } from '@gense/protocol'
import { BookOpen, Compass, GitBranch, Plug, Plus, Puzzle, Search, Upload, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { report, useClient, useHost } from '../../app/client'
import { Page } from '../../app/Shell'
import { cn } from '../../lib/cn'
import { errorText } from '../../lib/format'
import { navigate } from '../../lib/router'
import { Button } from '../../ui/button'
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter } from '../../ui/dialog'
import { Empty, Notice, Skeleton } from '../../ui/feedback'
import { Input } from '../../ui/input'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../../ui/menu'
import { Tabs, TabsList, TabsTrigger } from '../../ui/tabs'
import { InstallForm, PresetForm } from './AddForms'
import { CatalogGrid, CatalogSection, type CardActions } from './CatalogGrid'
import { discoverEntry, isAdded, matches, pluginEntry, skillEntry, type Entry } from './catalog'
import { EntryIcon } from './PluginCard'
import { McpForm, PluginDetail, SkillDetail } from './PluginDetail'

type Tab = 'plugins' | 'skills'
type View = 'installed' | 'discover'
type Opened = { plugin: string } | { skill: string } | { preset: DiscoverItem }
type Adding = 'mcp' | 'git' | 'zip' | { preset: DiscoverItem }

/** A detail dialog is full screen on a phone (B2) and a centered dialog from `sm` up. */
const detailClass = 'h-dvh max-h-dvh rounded-none sm:h-auto sm:max-h-[min(88dvh,760px)] sm:rounded-2xl'

/** The Discover catalog, fetched once per visit; `retry` after an error. */
function useCatalog() {
  const client = useClient()
  const [state, setState] = useState<{ items: DiscoverItem[] | null; error: string | null }>({ items: null, error: null })
  const load = useCallback(() => {
    setState({ items: null, error: null })
    client.request<DiscoverItem[]>({ t: 'discover' }).then(
      (items) => setState({ items, error: null }),
      (e: unknown) => setState({ items: null, error: errorText(e) }),
    )
  }, [client])
  useEffect(load, [load])
  return { ...state, retry: load }
}

export default function PluginsPage({ tab }: { tab: Tab }) {
  const client = useClient()
  const { plugins, skills, canInstallSkills } = useHost()
  const catalog = useCatalog()
  const [view, setView] = useState<View>('installed')
  const [query, setQuery] = useState('')
  const [opened, setOpened] = useState<Opened | null>(null)
  const [adding, setAdding] = useState<Adding | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [removing, setRemoving] = useState<Entry | null>(null)

  const items = catalog.items ?? []
  const installed = useMemo(
    () =>
      tab === 'plugins'
        ? (plugins ?? []).map((p) => pluginEntry(p, items)).sort((a, b) => Number(b.kind === 'mcp') - Number(a.kind === 'mcp'))
        : skills.map((s) => skillEntry(s, items)),
    [tab, plugins, skills, items],
  )
  const discover = useMemo(
    () => items.filter((d) => (tab === 'plugins' ? d.kind !== 'skill' : d.kind === 'skill')).map((d) => discoverEntry(d, plugins ?? [], skills)),
    [tab, items, plugins, skills],
  )

  const openPlugin = (p: PluginInfo) => setOpened({ plugin: p.id })

  /** `+` on a card (B4). OAuth presets open their sign-in window in this click, so the browser allows it. */
  const add = (e: Entry) => {
    const install = e.preset?.install
    const run = (work: () => Promise<unknown>) => {
      setBusy(e.key)
      work()
        .catch(report)
        .finally(() => setBusy(null))
    }
    if (e.kind === 'builtin' && e.plugin) {
      if (e.plugin.issue) return openPlugin(e.plugin)
      return run(() => client.request({ t: 'plugin.set', pluginId: e.plugin!.id, enabled: true }))
    }
    if (!install) return
    if ('git' in install)
      return run(() =>
        client.request({ t: 'skill.install', source: install }).then(() => {
          toast.success(`已安装 ${e.name}`)
        }),
      )
    if (install.fields?.length) return setAdding({ preset: e.preset! })
    const win = install.oauth ? window.open('', '_blank') : null
    run(() =>
      addMcp(e.preset!, install.mcp, win).catch((err: unknown) => {
        win?.close()
        throw err
      }),
    )
  }

  /** Adds a preset's server; when it asks for sign-in, sends `win` to the sign-in page. Opens its detail either way. */
  const addMcp = async (preset: DiscoverItem, url: string, win: Window | null) => {
    const plugin = await client.request<PluginInfo>({ t: 'mcp.add', name: preset.name, url })
    setAdding(null)
    setOpened({ plugin: plugin.id })
    if (plugin.mcp?.status !== 'auth') return void win?.close()
    const { url: signIn } = await client.request<{ url: string }>({ t: 'mcp.auth', pluginId: plugin.id })
    if (win) win.location.href = signIn
    else toast('需要登录', { description: '在详情里点“登录授权”完成连接。' })
  }

  const open = (e: Entry) => {
    if (e.plugin && (isAdded(e) || e.kind === 'builtin')) return openPlugin(e.plugin)
    if (e.skill) return setOpened({ skill: e.skill.name })
    if (e.preset) setOpened({ preset: e.preset })
  }

  const menu = (e: Entry): ReactNode => {
    const p = e.plugin
    const s = e.skill
    const enabled = p ? p.enabled : !!s?.enabled
    const canSwitch = p ? p.available && (enabled || !p.issue || p.kind === 'mcp') : !!s && !s.plugin
    const removable = p?.kind === 'mcp' || (!!s && s.source !== 'builtin')
    return (
      <>
        <DropdownMenuItem onSelect={() => open(e)}>查看详情</DropdownMenuItem>
        {canSwitch && (
          <DropdownMenuItem
            onSelect={() =>
              void (p
                ? client.request({ t: 'plugin.set', pluginId: p.id, enabled: !enabled })
                : client.request({ t: 'skill.set', name: s!.name, enabled: !enabled })
              ).catch(report)
            }
          >
            {enabled ? '停用' : '启用'}
          </DropdownMenuItem>
        )}
        {removable && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={() => setRemoving(e)}>
              {p ? '移除' : '卸载'}
            </DropdownMenuItem>
          </>
        )}
      </>
    )
  }

  const actions: CardActions = { open, add, adding: busy, menu }
  const searching = query.trim() !== ''

  return (
    <Page title="插件与 Skill" description="插件给助手工具，Skill 教它怎么完成一类任务。" actions={<AddMenu canInstallSkills={canInstallSkills} onPick={setAdding} />}>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <Tabs value={tab} onValueChange={(v) => navigate(v === 'skills' ? { name: 'plugins', tab: 'skills' } : { name: 'plugins' }, { replace: true })}>
          <TabsList>
            <TabsTrigger value="plugins">
              <Puzzle className="size-4" /> 插件
            </TabsTrigger>
            <TabsTrigger value="skills">
              <BookOpen className="size-4" /> Skills
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <ViewSwitch value={view} onChange={setView} disabled={searching} />
      </div>
      <div className="relative mb-6">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
          placeholder={tab === 'plugins' ? '搜索插件和 MCP 服务器' : '搜索 Skill'}
          aria-label="搜索"
          className="h-11 rounded-xl pr-10 pl-10"
        />
        {searching && (
          <Button variant="ghost" size="icon-sm" aria-label="清除搜索" className="absolute top-1/2 right-1.5 -translate-y-1/2" onClick={() => setQuery('')}>
            <X />
          </Button>
        )}
      </div>

      {tab === 'skills' && !canInstallSkills && (
        <Notice tone="warning" className="mb-5">
          这台服务器不能解压或拉取 Skill（缺少 unzip 或 git）。
        </Notice>
      )}

      {searching ? (
        <SearchResults query={query.trim()} installed={installed} discover={discover} catalogError={catalog.error} actions={actions} />
      ) : view === 'installed' ? (
        tab === 'plugins' ? (
          <InstalledPlugins entries={plugins ? installed : null} actions={actions} onAdd={() => setAdding('mcp')} onDiscover={() => setView('discover')} />
        ) : (
          <InstalledSkills entries={installed} actions={actions} canInstall={canInstallSkills} onAdd={() => setAdding('git')} onDiscover={() => setView('discover')} />
        )
      ) : (
        <Discover tab={tab} entries={catalog.items && (tab === 'skills' || plugins) ? discover : null} error={catalog.error} retry={catalog.retry} actions={actions} />
      )}

      <Dialog open={!!opened} onOpenChange={(v) => !v && setOpened(null)}>
        {opened && <OpenedDetail opened={opened} catalog={items} onClose={() => setOpened(null)} onAdd={add} adding={busy} />}
      </Dialog>

      <Dialog open={!!adding} onOpenChange={(v) => !v && setAdding(null)}>
        {adding === 'mcp' ? (
          <DialogContent title="添加 MCP 服务器" description="服务器地址和请求头保存在服务器上；请求头的值不会再显示。">
            <McpForm
              onDone={(added) => {
                setAdding(null)
                if (added) setOpened({ plugin: added.id })
              }}
            />
          </DialogContent>
        ) : adding === 'git' || adding === 'zip' ? (
          <DialogContent title="安装 Skill" description="会安装来源里找到的每一个 Skill；同名的会被替换。">
            <InstallForm initial={adding} onDone={() => setAdding(null)} />
          </DialogContent>
        ) : adding ? (
          <DialogContent title={`添加${adding.preset.name}`} description={adding.preset.description}>
            <PresetForm item={adding.preset} onCancel={() => setAdding(null)} onSubmit={(url) => addMcp(adding.preset, url, null)} />
          </DialogContent>
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(v) => !v && setRemoving(null)}
        title={removing ? `${removing.plugin ? '移除' : '卸载'}「${removing.name}」？` : ''}
        confirm={removing?.plugin ? '移除' : '卸载'}
        onConfirm={() => {
          const e = removing
          if (!e) return
          void (e.plugin ? client.request({ t: 'mcp.remove', pluginId: e.plugin.id }) : client.request({ t: 'skill.remove', name: e.skill!.name })).catch(report)
        }}
      >
        {removing?.plugin ? '它的工具不再可用，保存的请求头和登录也会删除。已有对话里的调用记录保留。' : '它的文件会从服务器删除，可以再从原来的来源安装。'}
      </ConfirmDialog>
    </Page>
  )
}

function AddMenu({ canInstallSkills, onPick }: { canInstallSkills: boolean; onPick: (a: Adding) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="primary">
          <Plus /> 添加
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onPick('mcp')}>
          <Plug /> 添加 MCP 服务器
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!canInstallSkills} onSelect={() => onPick('git')}>
          <GitBranch /> 从 Git 安装 Skill
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canInstallSkills} onSelect={() => onPick('zip')}>
          <Upload /> 上传 Skill（zip）
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** “已安装 / 发现”: two radio buttons, arrow keys move between them. */
function ViewSwitch({ value, onChange, disabled }: { value: View; onChange: (v: View) => void; disabled: boolean }) {
  const options: { value: View; label: string }[] = [
    { value: 'installed', label: '已安装' },
    { value: 'discover', label: '发现' },
  ]
  return (
    <div role="radiogroup" aria-label="显示" className={cn('inline-flex rounded-full border p-0.5', disabled && 'opacity-50')}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
            const next = value === 'installed' ? 'discover' : 'installed'
            onChange(next)
            ;(e.currentTarget.parentElement?.querySelector(`[data-view="${next}"]`) as HTMLElement | null)?.focus()
          }}
          data-view={o.value}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-sm transition-colors',
            value === o.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.value === 'discover' && <Compass className="size-3.5" />}
          {o.label}
        </button>
      ))}
    </div>
  )
}

function GridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2" aria-busy>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-[92px] rounded-2xl" />
      ))}
    </div>
  )
}

function InstalledPlugins({ entries, actions, onAdd, onDiscover }: { entries: Entry[] | null; actions: CardActions; onAdd: () => void; onDiscover: () => void }) {
  if (!entries) return <GridSkeleton count={6} />
  const mcp = entries.filter((e) => e.kind === 'mcp')
  const builtin = entries.filter((e) => e.kind === 'builtin')
  return (
    <>
      <CatalogSection title="MCP 服务器" count={mcp.length}>
        {mcp.length === 0 ? (
          <Empty
            icon={<Plug />}
            title="还没有 MCP 服务器"
            action={
              <div className="mt-2 flex flex-wrap justify-center gap-2">
                <Button onClick={onDiscover}>
                  <Compass /> 去发现
                </Button>
                <Button variant="ghost" onClick={onAdd}>
                  <Plus /> 填写地址添加
                </Button>
              </div>
            }
          >
            连接支持 Streamable HTTP 的 MCP 服务器，它的工具和界面（MCP Apps）会出现在对话里。
          </Empty>
        ) : (
          <CatalogGrid entries={mcp} actions={actions} />
        )}
      </CatalogSection>
      <CatalogSection title="内置插件" count={builtin.length} description="关闭后，助手不能调用它的工具。">
        <CatalogGrid entries={builtin} actions={actions} />
      </CatalogSection>
    </>
  )
}

function InstalledSkills({ entries, actions, canInstall, onAdd, onDiscover }: { entries: Entry[]; actions: CardActions; canInstall: boolean; onAdd: () => void; onDiscover: () => void }) {
  return (
    <CatalogSection
      title="Skills"
      count={entries.length}
      description={
        <>
          带 <code className="font-mono text-[13px]">SKILL.md</code> 的文件夹（Agent Skills 格式）。任务符合时助手自动使用，也可以在输入框用 / 指定。
        </>
      }
    >
      {entries.length === 0 ? (
        <Empty
          icon={<BookOpen />}
          title="还没有 Skill"
          action={
            <div className="mt-2 flex flex-wrap justify-center gap-2">
              <Button onClick={onDiscover}>
                <Compass /> 去发现
              </Button>
              <Button variant="ghost" disabled={!canInstall} onClick={onAdd}>
                <GitBranch /> 从 Git 安装
              </Button>
            </div>
          }
        >
          兼容为 Claude 等助手编写的 Agent Skills。
        </Empty>
      ) : (
        <CatalogGrid entries={entries} actions={actions} />
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        只给某个对话用的 Skill：让助手在工作区写 <code className="font-mono">skills/&lt;名称&gt;/SKILL.md</code>，下一轮起在那个对话里生效。
      </p>
    </CatalogSection>
  )
}

function CatalogError({ error, retry }: { error: string; retry: () => void }) {
  return (
    <Notice
      tone="error"
      title="没能加载发现目录"
      action={
        <Button size="sm" onClick={retry}>
          重试
        </Button>
      }
    >
      {error}
    </Notice>
  )
}

function Discover({ tab, entries, error, retry, actions }: { tab: Tab; entries: Entry[] | null; error: string | null; retry: () => void; actions: CardActions }) {
  if (error) return <CatalogError error={error} retry={retry} />
  if (!entries) return <GridSkeleton />
  if (tab === 'skills')
    return (
      <CatalogSection title="精选 Skill" description="从 Git 仓库一键安装。Skill 里的说明和脚本会被助手读取和执行。">
        {entries.length ? <CatalogGrid entries={entries} actions={actions} /> : <Empty icon={<BookOpen />} title="暂时没有推荐的 Skill" />}
      </CatalogSection>
    )
  const mcp = entries.filter((e) => e.kind === 'mcp')
  const builtin = entries.filter((e) => e.kind === 'builtin')
  return (
    <>
      <CatalogSection title="推荐 MCP 服务器" count={mcp.length}>
        {mcp.length ? <CatalogGrid entries={mcp} actions={actions} /> : <Empty icon={<Plug />} title="暂时没有推荐的服务器" />}
      </CatalogSection>
      <CatalogSection title="内置插件" count={builtin.length}>
        <CatalogGrid entries={builtin} actions={actions} />
      </CatalogSection>
    </>
  )
}

/** B5: one query over both lists; an entry installed from Discover shows once, under 已安装. */
function SearchResults({ query, installed, discover, catalogError, actions }: { query: string; installed: Entry[]; discover: Entry[]; catalogError: string | null; actions: CardActions }) {
  const mine = installed.filter((e) => matches(e, query))
  const seen = new Set(mine.flatMap((e) => [e.plugin?.id, e.skill?.name].filter(Boolean)))
  const found = discover.filter((e) => !(e.plugin && seen.has(e.plugin.id)) && !(e.skill && seen.has(e.skill.name)) && matches(e, query))
  if (!mine.length && !found.length)
    return (
      <>
        {catalogError && <Notice tone="warning" className="mb-4">发现目录没有加载，只搜索了已安装的。</Notice>}
        <Empty icon={<Search />} title={`没有找到“${query}”`}>
          换个关键词，或者用右上角的“添加”填写地址接入。
        </Empty>
      </>
    )
  return (
    <>
      {mine.length > 0 && (
        <CatalogSection title="已安装" count={mine.length}>
          <CatalogGrid entries={mine} actions={actions} />
        </CatalogSection>
      )}
      {found.length > 0 && (
        <CatalogSection title="发现" count={found.length}>
          <CatalogGrid entries={found} actions={actions} />
        </CatalogSection>
      )}
    </>
  )
}

/** The dialog for what a card opened: an installed plugin or Skill, or a preset not added yet. */
function OpenedDetail({ opened, catalog, onClose, onAdd, adding }: { opened: Opened; catalog: DiscoverItem[]; onClose: () => void; onAdd: (e: Entry) => void; adding: string | null }) {
  const { plugins, skills } = useHost()
  if ('preset' in opened) {
    const e = discoverEntry(opened.preset, plugins ?? [], skills)
    return (
      <DialogContent title={<Titled entry={e} />} className={detailClass}>
        <DialogBody className="flex flex-col gap-3 text-sm">
          <p>{e.description}</p>
          <p className="text-muted-foreground">提供方：{e.by}</p>
          {e.preset?.homepage && (
            <a href={e.preset.homepage} target="_blank" rel="noreferrer" className="self-start text-accent underline-offset-4 hover:underline">
              查看说明
            </a>
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            variant="primary"
            disabled={adding === e.key}
            onClick={() => {
              onClose()
              onAdd(e)
            }}
          >
            <Plus /> 添加
          </Button>
        </DialogFooter>
      </DialogContent>
    )
  }
  if ('plugin' in opened) {
    const p = plugins?.find((x) => x.id === opened.plugin)
    if (!p) return null
    const e = pluginEntry(p, catalog)
    return (
      <DialogContent title={<Titled entry={e} />} description={p.description ? <span className="line-clamp-3">{p.description}</span> : undefined} className={cn(detailClass, 'sm:max-w-xl')}>
        <PluginDetail key={p.id} plugin={p} onRemoved={onClose} />
      </DialogContent>
    )
  }
  const s = skills.find((x) => x.name === opened.skill)
  if (!s) return null
  return (
    <DialogContent title={<Titled entry={skillEntry(s, catalog)} />} description={<span className="line-clamp-3" title={s.description}>{s.description}</span>} className={cn(detailClass, 'sm:max-w-2xl')}>
      <SkillDetail key={s.name} skill={s} onRemoved={onClose} />
    </DialogContent>
  )
}

function Titled({ entry }: { entry: Entry }) {
  return (
    <span className="flex items-center gap-2.5">
      <EntryIcon entry={entry} className="size-7 rounded-lg text-sm" />
      <span className="min-w-0 truncate">{entry.name}</span>
    </span>
  )
}
