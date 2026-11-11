// A conversation's branches (roadmap-3 R38, R39): a small map in the header, and a dialog with the whole tree. Each
// branch is a lane from where it forks to its last entry; x follows entry order, so siblings line up where they fork.
import type { BranchesState, BranchMeta } from '@gense/protocol'
import { Minus, Plus } from 'lucide-react'
import { useRef, useState } from 'react'
import { cn } from '../../lib/cn'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Dialog, DialogContent } from '../../ui/dialog'
import { Tooltip } from '../../ui/tooltip'

interface Lane {
  branch: BranchMeta
  y: number
  x0: number
  x1: number
  parentY: number | null
}

const statusText: Record<BranchMeta['status'], string> = { idle: '空闲', running: '运行中', done: '已完成', failed: '失败', aborted: '已停止' }
const statusBadge: Record<BranchMeta['status'], 'neutral' | 'accent' | 'success' | 'destructive' | 'warning'> = {
  idle: 'neutral',
  running: 'accent',
  done: 'success',
  failed: 'destructive',
  aborted: 'warning',
}

export const branchName = (b: BranchMeta) => (b.role === 'main' ? '主线' : b.title || '（空分叉）')

/** Lanes depth first from the main branch, children by age; x is the rank of an entry id among all the tree's points. */
function layout(state: BranchesState): { lanes: Lane[]; width: number } {
  const points = [...new Set(state.branches.flatMap((b) => [b.forkEntryId, b.lastEntryId]).filter((n): n is number => n !== null))].sort((a, b) => a - b)
  const x = (id: number | null) => (id === null ? 0 : points.indexOf(id) + 1)
  const children = new Map<string | null, BranchMeta[]>()
  for (const b of state.branches) children.set(b.parentId, [...(children.get(b.parentId) ?? []), b])
  const lanes: Lane[] = []
  const known = new Set(state.branches.map((b) => b.id))
  const visit = (b: BranchMeta, parentY: number | null) => {
    const y = lanes.length
    const x0 = x(b.forkEntryId)
    lanes.push({ branch: b, y, x0, x1: Math.max(x(b.lastEntryId), x0 + 0.5), parentY })
    for (const c of children.get(b.id) ?? []) visit(c, y)
  }
  // Roots: the main branch, and any branch whose parent is gone.
  for (const b of state.branches) if (b.parentId === null || !known.has(b.parentId)) visit(b, null)
  return { lanes, width: Math.max(1, points.length) }
}

function Lanes({
  lanes,
  sx,
  sy,
  shown,
  focus,
  onFocus,
  onPick,
}: {
  lanes: Lane[]
  sx: number
  sy: number
  shown: string
  focus?: string
  onFocus?: (id: string) => void
  onPick?: (id: string) => void
}) {
  return (
    <>
      {lanes.map((l) => {
        const here = l.branch.id === shown
        const stroke = here ? 'var(--accent)' : 'var(--input)'
        return (
          <g key={l.branch.id} stroke={stroke} strokeWidth={here ? 2.5 : 2} strokeLinecap="round" strokeDasharray={l.branch.role === 'agent' ? '4 4' : undefined}>
            {l.parentY !== null && (
              <path d={`M${l.x0 * sx} ${l.parentY * sy} C${l.x0 * sx + sx * 0.4} ${l.parentY * sy}, ${l.x0 * sx} ${l.y * sy}, ${l.x0 * sx + sx * 0.5} ${l.y * sy}`} fill="none" />
            )}
            <line x1={l.x0 * sx + (l.parentY === null ? 0 : sx * 0.5)} y1={l.y * sy} x2={l.x1 * sx} y2={l.y * sy} />
            {onPick && (
              <circle
                cx={l.x1 * sx}
                cy={l.y * sy}
                r={focus === l.branch.id ? 8 : 6.5}
                strokeDasharray="none"
                fill={here ? 'var(--accent)' : 'var(--card)'}
                tabIndex={0}
                role="button"
                aria-label={`${branchName(l.branch)}，${statusText[l.branch.status]}`}
                className={cn('cursor-pointer outline-none focus-visible:stroke-ring', l.branch.status === 'running' && 'animate-pulse')}
                onPointerEnter={() => onFocus?.(l.branch.id)}
                onFocus={() => onFocus?.(l.branch.id)}
                onClick={() => onPick(l.branch.id)}
                onKeyDown={(e) => e.key === 'Enter' && onPick(l.branch.id)}
              />
            )}
            {onPick && (
              <text x={l.x1 * sx + 14} y={l.y * sy + 4} stroke="none" fill={here ? 'var(--foreground)' : 'var(--muted-foreground)'} fontSize={13} fontWeight={here ? 600 : 400}>
                {branchName(l.branch).slice(0, 24)}
              </text>
            )}
          </g>
        )
      })}
    </>
  )
}

/** The header's map of a conversation with more than one branch; it opens the tree dialog. */
export function BranchMap({ state, shown, onShow }: { state: BranchesState; shown: string; onShow: (branchId: string) => void }) {
  const [open, setOpen] = useState(false)
  if (state.branches.length < 2) return null
  const { lanes, width } = layout(state)
  const sx = 64 / width
  const sy = Math.min(6, 16 / Math.max(1, lanes.length - 1))
  return (
    <>
      <Tooltip label={`会话树 · ${state.branches.length} 个分支`}>
        <button type="button" aria-label={`会话树：${state.branches.length} 个分支`} onClick={() => setOpen(true)} className="grid h-9 shrink-0 place-items-center rounded-lg px-1.5 hover:bg-hover">
          <svg width={76} height={24} viewBox={`-4 -4 72 ${Math.max(8, (lanes.length - 1) * sy + 8)}`} aria-hidden>
            <Lanes lanes={lanes} sx={sx} sy={sy} shown={shown} />
          </svg>
        </button>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="会话树" description="每条线是一个分支；点一个端点切换过去。" className="sm:max-w-3xl">
          <Tree
            lanes={lanes}
            shown={shown}
            onPick={(id) => {
              setOpen(false)
              if (id !== shown) onShow(id)
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}

const SX = 56
const SY = 44

function Tree({ lanes, shown, onPick }: { lanes: Lane[]; shown: string; onPick: (id: string) => void }) {
  const [focus, setFocus] = useState(shown)
  const [view, setView] = useState({ k: 1, x: 32, y: 32 })
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)
  const focused = lanes.find((l) => l.branch.id === focus)?.branch
  const zoom = (f: number, cx = 0, cy = 0) =>
    setView((v) => {
      const k = Math.min(3, Math.max(0.3, v.k * f))
      return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k }
    })
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative mx-5 min-h-0 flex-1 overflow-hidden rounded-xl border bg-background">
        <svg
          className="block h-[min(46dvh,380px)] w-full cursor-grab touch-none active:cursor-grabbing"
          onWheel={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top)
          }}
          onPointerDown={(e) => {
            if ((e.target as Element).tagName === 'circle') return
            e.currentTarget.setPointerCapture(e.pointerId)
            drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
          }}
          onPointerMove={(e) => {
            const d = drag.current
            if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }))
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
        >
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            <Lanes lanes={lanes} sx={SX} sy={SY} shown={shown} focus={focus} onFocus={setFocus} onPick={onPick} />
          </g>
        </svg>
        <div className="absolute top-2 right-2 flex gap-1">
          <Button size="icon-sm" aria-label="缩小" onClick={() => zoom(1 / 1.25)}>
            <Minus />
          </Button>
          <Button size="icon-sm" aria-label="放大" onClick={() => zoom(1.25)}>
            <Plus />
          </Button>
        </div>
      </div>
      {focused && (
        <div className="flex items-start gap-3 px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <strong className="truncate">{branchName(focused)}</strong>
              <Badge variant={statusBadge[focused.status]}>{statusText[focused.status]}</Badge>
              {focused.role === 'agent' && <Badge variant="outline">子代理</Badge>}
            </div>
            {focused.preview && <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{focused.preview}</p>}
          </div>
          <Button variant="primary" disabled={focused.id === shown} onClick={() => onPick(focused.id)}>
            {focused.id === shown ? '正在查看' : '切换到这里'}
          </Button>
        </div>
      )}
    </div>
  )
}
