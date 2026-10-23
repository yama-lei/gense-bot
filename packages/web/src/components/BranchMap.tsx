import { useEffect, useRef, useState } from 'react'
import type { BranchesState, BranchMeta } from '@gense/core/protocol'
import { IconBranch, IconX } from './Icons'

// A tree's branches (roadmap-3 R38, R39): a small map in the top bar, and a dialog with the whole tree. Each branch is
// a lane from where it forks to its last entry; x follows entry order, so siblings line up where they branch off.

interface Lane {
  branch: BranchMeta
  y: number
  x0: number
  x1: number
  parentY: number | null
}

const statusText: Record<BranchMeta['status'], string> = { idle: '空闲', running: '运行中', done: '已完成', failed: '失败', aborted: '已停止' }

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

const laneClass = (l: Lane, shown: string) =>
  'branch-lane' + (l.branch.id === shown ? ' shown' : '') + (l.branch.status === 'running' ? ' running' : '') + (l.branch.role === 'agent' ? ' agent' : '')

function Lanes({ lanes, sx, sy, shown, focus, onFocus, onPick }: { lanes: Lane[]; sx: number; sy: number; shown: string; focus?: string; onFocus?: (id: string) => void; onPick?: (id: string) => void }) {
  return (
    <>
      {lanes.map((l) => (
        <g key={l.branch.id} className={laneClass(l, shown) + (focus === l.branch.id ? ' focus' : '')}>
          {l.parentY !== null && <path d={`M${l.x0 * sx} ${l.parentY * sy} C${l.x0 * sx + sx * 0.4} ${l.parentY * sy}, ${l.x0 * sx} ${l.y * sy}, ${l.x0 * sx + sx * 0.5} ${l.y * sy}`} fill="none" />}
          <line x1={l.x0 * sx + (l.parentY === null ? 0 : sx * 0.5)} y1={l.y * sy} x2={l.x1 * sx} y2={l.y * sy} />
          {onPick && (
            <circle
              cx={l.x1 * sx}
              cy={l.y * sy}
              r={7}
              tabIndex={0}
              role="button"
              aria-label={`${l.branch.title || '（空分叉）'}，${statusText[l.branch.status]}`}
              onPointerEnter={() => onFocus?.(l.branch.id)}
              onFocus={() => onFocus?.(l.branch.id)}
              onClick={() => onPick(l.branch.id)}
              onKeyDown={(e) => e.key === 'Enter' && onPick(l.branch.id)}
            />
          )}
          {onPick && (
            <text x={l.x1 * sx + 12} y={l.y * sy + 4}>
              {l.branch.role === 'main' ? '主线' : l.branch.title || '（空分叉）'}
            </text>
          )}
        </g>
      ))}
    </>
  )
}

/** The top bar's map of a tree with more than one branch; it opens the tree dialog. */
export function BranchMap({ state, shown, onShow }: { state: BranchesState; shown: string; onShow: (branchId: string) => void }) {
  const [open, setOpen] = useState(false)
  if (state.branches.length < 2) return null
  const { lanes, width } = layout(state)
  const sx = 64 / width
  const sy = Math.min(6, 16 / Math.max(1, lanes.length - 1))
  return (
    <>
      <button className="branch-minimap" aria-label={`会话树：${state.branches.length} 个分叉`} title="会话树" onClick={() => setOpen(true)}>
        <svg width={76} height={24} viewBox={`-4 -4 72 ${Math.max(8, (lanes.length - 1) * sy + 8)}`} aria-hidden>
          <Lanes lanes={lanes} sx={sx} sy={sy} shown={shown} />
        </svg>
      </button>
      {open && (
        <TreeDialog
          lanes={lanes}
          shown={shown}
          onClose={() => setOpen(false)}
          onPick={(id) => {
            setOpen(false)
            if (id !== shown) onShow(id)
          }}
        />
      )}
    </>
  )
}

const SX = 56
const SY = 44

function TreeDialog({ lanes, shown, onClose, onPick }: { lanes: Lane[]; shown: string; onClose: () => void; onPick: (id: string) => void }) {
  const [focus, setFocus] = useState(shown)
  const [view, setView] = useState({ k: 1, x: 32, y: 32 })
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)
  const focused = lanes.find((l) => l.branch.id === focus)?.branch
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const zoom = (f: number, cx = 0, cy = 0) => setView((v) => {
    const k = Math.min(3, Math.max(0.3, v.k * f))
    return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k }
  })
  return (
    <>
      <div className="menu-scrim dim" onClick={onClose} />
      <div className="tree-dialog" role="dialog" aria-modal="true" aria-label="会话树">
        <div className="side-panel-head">
          <IconBranch width={16} height={16} />
          <strong>会话树</strong>
          <button className="icon-btn" aria-label="缩小" onClick={() => zoom(1 / 1.25)}>−</button>
          <button className="icon-btn" aria-label="放大" onClick={() => zoom(1.25)}>+</button>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}>
            <IconX />
          </button>
        </div>
        <svg
          className="tree-canvas"
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
        >
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            <Lanes lanes={lanes} sx={SX} sy={SY} shown={shown} focus={focus} onFocus={setFocus} onPick={onPick} />
          </g>
        </svg>
        {focused && (
          <div className="tree-summary">
            <div className="tree-summary-head">
              <strong className="ellipsis">{focused.role === 'main' ? '主线' : focused.title || '（空分叉）'}</strong>
              <span className={'status-chip ' + (focused.status === 'running' ? 'running' : 'succeeded')}>{statusText[focused.status]}</span>
              {focused.role === 'agent' && <span className="tag">子代理</span>}
            </div>
            {focused.preview && <p className="small muted">{focused.preview}</p>}
            <button className="pill-btn" disabled={focused.id === shown} onClick={() => onPick(focused.id)}>
              {focused.id === shown ? '正在查看' : '切换到这里'}
            </button>
          </div>
        )}
      </div>
    </>
  )
}
