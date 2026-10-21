import { useState } from 'react'
import { MOCK } from '../mode'
import { href, type Route } from '../router'
import type { AppState } from '../types'
import { IconChevronRight, IconClock, IconDoc, IconPlus, IconProject, IconSearch, IconSidebar, IconSliders } from './Icons'

interface Props {
  state: AppState
  route: Route
  open: boolean
  onClose: () => void
  onReset: () => void
}

export function Sidebar({ state, route, open, onClose, onReset }: Props) {
  const [query, setQuery] = useState('')
  const [moreOpen, setMoreOpen] = useState(false)
  const activeChat = route.name === 'chat' ? route.id : null
  const q = query.trim().toLowerCase()

  const recent = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt)
  const matches = q ? recent.filter((c) => c.title.toLowerCase().includes(q) || c.turns.some((t) => (t.userMessage + t.assistantMessage).toLowerCase().includes(q))) : []
  const pinned = state.projects.filter((p) => p.pinned)
  const loose = recent.filter((c) => !c.projectId || c.pinned)

  const nav = [
    { label: '项目', icon: <IconProject />, to: href({ name: 'projects' }), active: route.name === 'projects' || route.name === 'project' },
    { label: '资料', icon: <IconDoc />, to: href({ name: 'files' }), active: route.name === 'files' },
    { label: '定时任务', icon: <IconClock />, to: href({ name: 'scheduled' }), active: route.name === 'scheduled' },
    { label: '定制', icon: <IconSliders />, to: href({ name: 'customize' }), active: route.name === 'customize' },
  ]

  return (
    <>
      <div className={'scrim' + (open ? ' show' : '')} onClick={onClose} />
      <aside className={'sidebar' + (open ? ' open' : '')}>
        <div className="sb-head">
          <button className="icon-btn" aria-label="收起侧栏" onClick={onClose}>
            <IconSidebar />
          </button>
          <a className="brand" href="#/">
            GenseBot
          </a>
          {MOCK && (
            <span className="mock-badge" title="数据全部在浏览器内伪造">
              Mock
            </span>
          )}
        </div>

        <label className="sb-search">
          <IconSearch />
          <input placeholder="搜索" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>

        <nav className="sb-nav">
          <a className={'sb-item' + (route.name === 'home' ? ' active' : '')} href="#/">
            <IconPlus /> 新对话
          </a>
          {nav.map((n) => (
            <a key={n.label} className={'sb-item' + (n.active ? ' active' : '')} href={n.to}>
              {n.icon} {n.label}
            </a>
          ))}
          {MOCK && (
            <button className="sb-item muted" onClick={() => setMoreOpen(!moreOpen)}>
              <IconChevronRight style={{ transform: moreOpen ? 'rotate(90deg)' : undefined, transition: 'transform .15s' }} /> 更多
            </button>
          )}
          {MOCK && moreOpen && (
            <button className="sb-item sub" onClick={onReset}>
              重置 Mock 数据
            </button>
          )}
        </nav>

        <div className="sb-scroll">
          {q ? (
            <>
              <div className="sb-label">搜索结果</div>
              {matches.length === 0 && <div className="sb-empty">没有匹配的会话</div>}
              {matches.map((c) => (
                <a key={c.id} className={'sb-item sub' + (c.id === activeChat ? ' active' : '')} href={href({ name: 'chat', id: c.id })}>
                  {c.title}
                </a>
              ))}
            </>
          ) : (
            <>
              <div className="sb-label">置顶</div>
              {pinned.map((p) => {
                const convs = recent.filter((c) => c.projectId === p.id).slice(0, 2)
                return (
                  <div key={p.id} className="sb-group">
                    <a className={'sb-item' + (route.name === 'project' && route.id === p.id ? ' active' : '')} href={href({ name: 'project', id: p.id })}>
                      <IconProject /> {p.name}
                    </a>
                    {convs.length > 0 && (
                      <div className="sb-children">
                        {convs.map((c) => (
                          <a key={c.id} className={'sb-item sub' + (c.id === activeChat ? ' active' : '')} href={href({ name: 'chat', id: c.id })}>
                            <span className="ellipsis">{c.title}</span>
                            <StatusDot conv={c.turns.at(-1)?.status} />
                          </a>
                        ))}
                        <a className="sb-item sub muted" href={href({ name: 'project', id: p.id })}>
                          查看全部
                        </a>
                      </div>
                    )}
                  </div>
                )
              })}
              <div className="sb-label">最近</div>
              {loose.map((c) => (
                <a key={c.id} className={'sb-item sub flush' + (c.id === activeChat ? ' active' : '')} href={href({ name: 'chat', id: c.id })}>
                  <span className="ellipsis">{c.title}</span>
                  <StatusDot conv={c.turns.at(-1)?.status} />
                </a>
              ))}
            </>
          )}
        </div>

        <div className="sb-foot">
          <span className="avatar">{state.account.name[0]}</span>
          <span className="ellipsis">{state.account.name}</span>
          <a className={'muted small drive-status' + (state.account.driveConnected ? '' : ' off')} href={href({ name: 'customize' })}>
            · Drive {state.account.driveConnected ? '已连接' : '未连接'}
          </a>
        </div>
      </aside>
    </>
  )
}

function StatusDot({ conv }: { conv?: string }) {
  if (conv === 'running' || conv === 'queued') return <span className="dot running" title="执行中" />
  if (conv === 'failed') return <span className="dot failed" title="失败" />
  return null
}
