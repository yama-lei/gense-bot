// One entry of the catalog grid (roadmap-6 B1): icon, name, a line of description and who makes it, with `+` to add
// it or `⋯` for what can be done with it once added. The whole card opens the detail.
import { MoreHorizontal, Plus } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Spinner } from '../../ui/feedback'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../../ui/menu'
import { isAdded, type Entry } from './catalog'
import { mcpStatus } from './PluginDetail'

/** The entry's SVG as an image (it never runs as markup), or its initial on a tinted tile. */
export function EntryIcon({ entry, className }: { entry: Pick<Entry, 'icon' | 'name'>; className?: string }) {
  if (entry.icon) return <img alt="" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(entry.icon)}`} className={cn('size-10 shrink-0 rounded-[10px]', className)} />
  return (
    <span aria-hidden className={cn('grid size-10 shrink-0 place-items-center rounded-[10px] bg-accent-soft text-base font-semibold text-accent uppercase', className)}>
      {[...entry.name.trim()][0] ?? '?'}
    </span>
  )
}

/** What the card says about its state, beside the name. */
function StateBadge({ entry: e }: { entry: Entry }) {
  const p = e.plugin
  if (p && !p.available) return <Badge>不可用</Badge>
  if (p?.mcp && p.enabled && p.mcp.status !== 'ready') return <Badge variant={mcpStatus[p.mcp.status].variant}>{mcpStatus[p.mcp.status].label}</Badge>
  if (p?.enabled && p.issue) return <Badge variant="warning">需要设置</Badge>
  if (p && !p.enabled && isAdded(e)) return <Badge>已停用</Badge>
  if (e.skill && !e.skill.enabled) return <Badge>已停用</Badge>
  return null
}

export function PluginCard({ entry, onOpen, onAdd, adding, menu }: { entry: Entry; onOpen: () => void; onAdd: () => void; adding: boolean; menu: ReactNode }) {
  // An entry that cannot be added here still has a menu, to open its detail and see why.
  const added = isAdded(entry) || entry.plugin?.available === false
  return (
    <li className="relative flex items-start gap-3 rounded-2xl border bg-card p-3.5 transition-colors focus-within:border-ring hover:bg-hover">
      <EntryIcon entry={entry} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          {/* The button covers the card, so a click anywhere opens it; the action button sits above it. */}
          <button type="button" onClick={onOpen} className="truncate text-left font-medium outline-none after:absolute after:inset-0 after:rounded-2xl">
            {entry.name}
          </button>
          <StateBadge entry={entry} />
        </div>
        <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground" title={entry.description}>
          {entry.description}
        </p>
        <p className="mt-1 truncate text-xs text-muted-foreground">{entry.by}</p>
      </div>
      <div className="relative z-10 -mt-1 -mr-1.5">
        {added ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`${entry.name} 的操作`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">{menu}</DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button variant="ghost" size="icon-sm" aria-label={`添加 ${entry.name}`} disabled={adding} onClick={onAdd}>
            {adding ? <Spinner /> : <Plus />}
          </Button>
        )}
      </div>
    </li>
  )
}
