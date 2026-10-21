import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { href, navigate } from '../router'
import type { Store } from '../store'
import type { Confirmation, Conversation, Effort, Turn } from '../types'
import { Composer, effortLabel } from './Composer'
import { IconAlert, IconArrowDown, IconCheck, IconChevronDown, IconChevronRight, IconInfo, IconMail, IconRetry, IconTool, IconX } from './Icons'
import { Markdown } from './Markdown'
import { TopBar } from './TopBar'

const statusLabel: Record<Turn['status'], string> = {
  queued: '已接收，排队中',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  interrupted: '已中断',
}

export function ChatView({ store, conv }: { store: Store; conv: Conversation }) {
  const last = conv.turns.at(-1)
  const [model, setModel] = useState(last?.model ?? store.state.prefs.model)
  const [effort, setEffort] = useState<Effort>(last?.effort ?? store.state.prefs.defaultEffort)
  const [showDetails, setShowDetails] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const busy = last?.status === 'queued' || last?.status === 'running'

  const scrollToBottom = (smooth = true) => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })

  useLayoutEffect(() => scrollToBottom(false), [conv.id])
  useEffect(() => {
    if (atBottom) scrollToBottom(false)
    // Follow streamed output only while the reader is already at the bottom.
  }, [last?.assistantMessage, last?.toolCalls.length, last?.status, conv.turns.length]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page chat">
      <TopBar
        right={
          <button className={'pill-btn' + (showDetails ? ' on' : '')} onClick={() => setShowDetails(!showDetails)}>
            任务详情
          </button>
        }
      >
        <TitleMenu store={store} conv={conv} />
      </TopBar>

      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
        }}
      >
        <div className="thread">
          {conv.turns.map((t) => (
            <TurnView key={t.id} turn={t} store={store} conv={conv} showDetails={showDetails} />
          ))}
        </div>
      </div>

      {!atBottom && (
        <button className="to-bottom" aria-label="回到底部" onClick={() => scrollToBottom()}>
          <IconArrowDown />
        </button>
      )}

      <div className="chat-composer">
        <Composer
          placeholder="回复…"
          model={model}
          effort={effort}
          onModel={setModel}
          onEffort={setEffort}
          busy={busy}
          onStop={() => last && store.stop(conv.id, last.id)}
          onSend={(text) => {
            store.reply(conv.id, text, model, effort)
            setAtBottom(true)
          }}
          footnote
        />
      </div>
    </div>
  )
}

function TitleMenu({ store, conv }: { store: Store; conv: Conversation }) {
  const [open, setOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const close = () => {
    setOpen(false)
    setConfirmDelete(false)
  }
  return (
    <div className="title-menu">
      <button className="title-btn" onClick={() => setOpen(!open)}>
        <span className="ellipsis">{conv.title}</span>
        <IconChevronDown width={16} height={16} />
      </button>
      {open && (
        <>
          <div className="menu-scrim" onClick={close} />
          <div className="menu">
            <button
              onClick={() => {
                const title = window.prompt('重命名会话', conv.title)
                if (title?.trim()) store.patchConv(conv.id, (c) => ({ ...c, title: title.trim() }))
                close()
              }}
            >
              重命名
            </button>
            <button
              onClick={() => {
                store.patchConv(conv.id, (c) => ({ ...c, pinned: !c.pinned }))
                close()
              }}
            >
              {conv.pinned ? '取消置顶' : '置顶到最近'}
            </button>
            <div className="menu-label">移入项目</div>
            {[{ id: null, name: '无项目' }, ...store.state.projects].map((p) => (
              <button
                key={p.id ?? 'none'}
                className={conv.projectId === p.id ? 'checked' : ''}
                onClick={() => {
                  store.patchConv(conv.id, (c) => ({ ...c, projectId: p.id }))
                  close()
                }}
              >
                {p.name}
                {conv.projectId === p.id && <IconCheck width={15} height={15} />}
              </button>
            ))}
            <div className="menu-sep" />
            {confirmDelete ? (
              <button
                className="danger"
                onClick={() => {
                  store.setState((s) => ({ ...s, conversations: s.conversations.filter((c) => c.id !== conv.id) }))
                  navigate({ name: 'home' })
                }}
              >
                确认删除？此操作不可撤销
              </button>
            ) : (
              <button className="danger" onClick={() => setConfirmDelete(true)}>
                删除
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function TurnView({ turn, store, conv, showDetails }: { turn: Turn; store: Store; conv: Conversation; showDetails: boolean }) {
  const [processOpen, setProcessOpen] = useState(false)
  const active = turn.status === 'queued' || turn.status === 'running'

  return (
    <section className="turn">
      <UserBubble text={turn.userMessage} />

      {showDetails && (
        <div className="turn-details">
          <span>请求 {turn.requestId}</span>
          <span>{turn.model}</span>
          <span>Effort {effortLabel[turn.effort]}</span>
          <span>{new Date(turn.createdAt).toLocaleString('zh-CN')}</span>
          <span className={'status-chip ' + turn.status}>{statusLabel[turn.status]}</span>
        </div>
      )}

      <div className="assistant">
        {turn.status === 'queued' ? (
          <div className="process pending">
            <span className="spinner" /> {statusLabel.queued}
          </div>
        ) : (
          <button className="process" onClick={() => setProcessOpen(!processOpen)} disabled={turn.toolCalls.length === 0}>
            {active && <span className="spinner" />}
            <span>{turn.summary ?? statusLabel[turn.status]}</span>
            {turn.toolCalls.length > 0 && (
              <>
                <span className="muted">· {turn.toolCalls.length} 次工具调用</span>
                <IconChevronRight width={14} height={14} style={{ transform: processOpen ? 'rotate(90deg)' : undefined }} />
              </>
            )}
          </button>
        )}

        {processOpen && (
          <ul className="tools">
            {turn.toolCalls.map((c) => (
              <li key={c.id} className={'tool ' + c.status}>
                <div className="tool-head">
                  <IconTool width={15} height={15} />
                  <code>{c.name}</code>
                  <span className={'status-chip ' + c.status}>{c.status === 'running' ? '执行中' : c.status === 'succeeded' ? '成功' : '失败'}</span>
                  {c.durationMs != null && c.status !== 'running' && <span className="muted small">{c.durationMs} ms</span>}
                </div>
                <div className="tool-body">
                  <div>
                    <span className="muted">参数</span> <code>{c.args}</code>
                  </div>
                  {c.output && (
                    <div>
                      <span className="muted">输出</span> {c.output}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {turn.assistantMessage && <Markdown text={turn.assistantMessage + (turn.status === 'running' ? ' ▍' : '')} />}

        {turn.citations.length > 0 && (
          <div className="citations">
            <span className="muted small">引用</span>
            {turn.citations.map((c, i) => (
              <a key={i} className="cite" href={href({ name: 'docs', path: c.path, line: c.line })}>
                {c.path}:{c.line}
              </a>
            ))}
          </div>
        )}

        {turn.confirmation && (
          <ConfirmCard
            confirmation={turn.confirmation}
            onChange={(confirmation) => store.patchTurn(conv.id, turn.id, (t) => ({ ...t, confirmation }))}
          />
        )}

        {turn.status === 'failed' && (
          <div className="banner error">
            <IconAlert />
            <div>
              <strong>任务失败</strong>
              <p>{turn.error}</p>
            </div>
            <button className="pill-btn" onClick={() => store.retry(conv.id, turn)}>
              <IconRetry width={15} height={15} /> 重试
            </button>
          </div>
        )}
        {turn.status === 'interrupted' && (
          <div className="banner warn">
            <IconInfo />
            <div>
              <strong>已中断</strong>
              <p>已产生的内容保留；未完成的工具调用不会自动重跑。</p>
            </div>
            <button className="pill-btn" onClick={() => store.retry(conv.id, turn)}>
              <IconRetry width={15} height={15} /> 重新提交
            </button>
          </div>
        )}
      </div>
    </section>
  )
}

function UserBubble({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)
  const [expanded, setExpanded] = useState(false)
  useLayoutEffect(() => {
    if (ref.current) setOverflow(ref.current.scrollHeight > 300)
  }, [text])
  return (
    <div className="user-row">
      <div className={'user-bubble' + (overflow && !expanded ? ' clamped' : '')}>
        <div ref={ref} className="user-text">
          {text}
        </div>
        {overflow && (
          <button className="link-btn" onClick={() => setExpanded(!expanded)}>
            {expanded ? '收起' : '展开'}
          </button>
        )}
      </div>
    </div>
  )
}

function ConfirmCard({ confirmation, onChange }: { confirmation: Confirmation; onChange: (c: Confirmation) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(confirmation.fields)
  const { state } = confirmation

  return (
    <div className={'confirm-card ' + state}>
      <div className="confirm-head">
        <IconMail />
        <strong>发送邮件前请确认</strong>
        {state !== 'pending' && <span className={'status-chip ' + (state === 'confirmed' ? 'succeeded' : 'interrupted')}>{state === 'confirmed' ? '已确认（Mock 未发送）' : '已取消'}</span>}
      </div>
      <dl>
        {(editing ? draft : confirmation.fields).map((f, i) => (
          <div key={f.label} className="confirm-field">
            <dt>{f.label}</dt>
            <dd>
              {editing ? (
                <textarea
                  value={f.value}
                  rows={f.label === '正文' ? 6 : 1}
                  onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, value: e.target.value } : d)))}
                />
              ) : (
                <span className="pre">{f.value}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className="confirm-consequence">
        <IconAlert width={15} height={15} /> {confirmation.consequence}
      </p>
      {state === 'pending' && (
        <div className="confirm-actions">
          {editing ? (
            <>
              <button
                className="btn primary"
                onClick={() => {
                  // Edited content invalidates any earlier confirmation: user must confirm again.
                  onChange({ ...confirmation, fields: draft, state: 'pending' })
                  setEditing(false)
                }}
              >
                保存修改
              </button>
              <button className="btn" onClick={() => (setDraft(confirmation.fields), setEditing(false))}>
                放弃修改
              </button>
            </>
          ) : (
            <>
              <button className="btn primary" onClick={() => onChange({ ...confirmation, state: 'confirmed' })}>
                <IconCheck width={15} height={15} /> 确认发送
              </button>
              <button className="btn" onClick={() => (setDraft(confirmation.fields), setEditing(true))}>
                修改
              </button>
              <button className="btn ghost" onClick={() => onChange({ ...confirmation, state: 'cancelled' })}>
                <IconX width={15} height={15} /> 取消
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
