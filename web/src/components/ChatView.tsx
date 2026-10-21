import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { tools, views } from '../plugins'
import type { DisplayMode, ViewHost } from '../plugins/types'
import { href, navigate } from '../router'
import type { Store } from '../store'
import type { Conversation, DriveFile, Effort, ToolCall, Turn } from '../types'
import { modelName, useModels } from '../models'
import { Composer, effortLabel } from './Composer'
import { IconAlert, IconArrowDown, IconCheck, IconChevronDown, IconChevronRight, IconCopy, IconDoc, IconInfo, IconRetry, IconTool, IconX } from './Icons'
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
  const [panel, setPanel] = useState<{ turnId: string; callId: string } | null>(null)
  const panelTurn = panel && conv.turns.find((t) => t.id === panel.turnId)
  const panelCall = panelTurn?.toolCalls.find((c) => c.id === panel!.callId)

  // Host side of the MCP Apps bridge for one rendered tool call.
  const hostFor = (turn: Turn, call: ToolCall): ViewHost => ({
    callTool: async (name, args) => {
      if (tools[name]?.plugin !== tools[call.name]?.plugin)
        return {
          content: `界面只能调用本插件的工具，${name} 被拒绝`,
          isError: true,
        }
      return store.callToolFromView(conv.id, turn.id, call.id, name, args)
    },
    sendMessage: (text) => store.reply(conv.id, text, model, effort),
    requestDisplayMode: (mode) => setPanel(mode === 'inline' ? null : { turnId: turn.id, callId: call.id }),
    setViewState: (state) => store.setViewState(conv.id, turn.id, call.id, state),
  })

  const scrollToBottom = (smooth = true) =>
    scroller.current?.scrollTo({
      top: scroller.current.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    })

  useLayoutEffect(() => {
    scrollToBottom(false)
  }, [conv.id])
  useEffect(() => {
    if (atBottom) scrollToBottom(false)
    // Follow streamed output only while the reader is already at the bottom.
  }, [last?.assistantMessage, last?.toolCalls.length, last?.status, conv.turns.length]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={'chat-layout' + (panelCall ? ' with-panel' : '')}>
      <div className="page chat">
        <TopBar>
          <TitleMenu store={store} conv={conv} showDetails={showDetails} onShowDetails={setShowDetails} />
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
            {conv.turns.length === 0 && !store.turnsLoaded(conv.id) && (
              <div className="page-loading muted">
                <span className="spinner" /> 正在载入会话…
              </div>
            )}
            {conv.turns.map((t) => (
              <TurnView key={t.id} turn={t} store={store} conv={conv} showDetails={showDetails} hostFor={hostFor} isLast={t === last} />
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
      {panelCall && panelTurn && (
        <aside className="side-panel" aria-label="插件面板">
          <div className="side-panel-head">
            <strong className="ellipsis">{(panelCall.input as { title?: string }).title ?? panelCall.name}</strong>
            <button className="icon-btn" aria-label="关闭面板" onClick={() => setPanel(null)}>
              <IconX />
            </button>
          </div>
          <div className="side-panel-body">
            <PluginSlot call={panelCall} displayMode="panel" host={hostFor(panelTurn, panelCall)} />
          </div>
        </aside>
      )}
    </div>
  )
}

/** Render selection: built-in React view → (later) MCP Apps iframe → generic card. */
function PluginSlot({ call, displayMode, host }: { call: ToolCall; displayMode: DisplayMode; host: ViewHost }) {
  const View = call.resourceUri ? views[call.resourceUri] : undefined
  if (!View) {
    return (
      <div className="generic-card">
        <IconTool width={15} height={15} /> <code>{call.name}</code>
        <p className="muted small">此工具声明了界面 {call.resourceUri}，MCP Apps 界面将在后续版本中以沙箱 iframe 显示。</p>
        {call.result && <p>{call.result.content}</p>}
      </div>
    )
  }
  return <View toolInput={call.input} toolResult={call.result} displayMode={displayMode} viewState={call.viewState} host={host} />
}

/** The quote is checked against the file's current text when the citation is opened. */
function CitationCard({ c, file }: { c: Turn['citations'][number]; file?: DriveFile }) {
  return (
    <a className="cite-card" href={href({ name: 'files', tab: file?.kind ?? 'drive', id: c.fileId, quote: c.quote })}>
      <span className="cite-name">
        <IconDoc width={14} height={14} /> <span className="ellipsis">{c.name}</span>
      </span>
      <span className="cite-quote">“{c.quote}”</span>
    </a>
  )
}

function TitleMenu({ store, conv, showDetails, onShowDetails }: { store: Store; conv: Conversation; showDetails: boolean; onShowDetails: (v: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editing, setEditing] = useState(false)
  const close = () => {
    setOpen(false)
    setConfirmDelete(false)
  }
  const rename = (title: string) => {
    setEditing(false)
    if (title.trim() && title.trim() !== conv.title) store.patchConv(conv.id, (c) => ({ ...c, title: title.trim() }))
  }

  if (editing)
    return (
      <input
        className="title-input"
        defaultValue={conv.title}
        autoFocus
        aria-label="会话标题"
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => rename(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) e.currentTarget.blur()
          if (e.key === 'Escape') setEditing(false)
        }}
      />
    )

  return (
    <div className="title-menu">
      <button className="title-btn" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        <span className="ellipsis">{conv.title}</span>
        <IconChevronDown width={16} height={16} />
      </button>
      {open && (
        <>
          <div className="menu-scrim" onClick={close} />
          <div className="menu" role="menu">
            <button
              onClick={() => {
                close()
                setEditing(true)
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
            <button
              className={showDetails ? 'checked' : ''}
              onClick={() => {
                onShowDetails(!showDetails)
                close()
              }}
            >
              显示任务详情
              {showDetails && <IconCheck width={15} height={15} />}
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

function TurnView({
  turn,
  store,
  conv,
  showDetails,
  hostFor,
  isLast,
}: {
  turn: Turn
  store: Store
  conv: Conversation
  showDetails: boolean
  hostFor: (t: Turn, c: ToolCall) => ViewHost
  isLast: boolean
}) {
  const models = useModels()
  const [processOpen, setProcessOpen] = useState(false)
  const active = turn.status === 'queued' || turn.status === 'running'

  return (
    <section className="turn">
      <UserBubble text={turn.userMessage} />

      {showDetails && (
        <div className="turn-details">
          <span>请求 {turn.requestId}</span>
          <span>{modelName(models, turn.model)}</span>
          <span>{effortLabel[turn.effort]}</span>
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
                <IconChevronRight
                  width={14}
                  height={14}
                  style={{
                    transform: processOpen ? 'rotate(90deg)' : undefined,
                  }}
                />
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
                  {c.origin === 'view' && <span className="tag">界面调用</span>}
                  {c.durationMs != null && c.status !== 'running' && <span className="muted small">{c.durationMs} ms</span>}
                </div>
                <div className="tool-body">
                  <div>
                    <span className="muted">参数</span> <code className="args">{JSON.stringify(c.input)}</code>
                  </div>
                  {c.result && <ToolOutput text={c.result.content} />}
                </div>
              </li>
            ))}
          </ul>
        )}

        {turn.assistantMessage && <Markdown text={turn.assistantMessage + (turn.status === 'running' ? ' ▍' : '')} />}

        {turn.toolCalls
          .filter((c) => c.resourceUri && c.origin === 'model' && c.status === 'succeeded')
          .map((c) => (
            <div key={c.id} className="plugin-slot">
              <PluginSlot call={c} displayMode="inline" host={hostFor(turn, c)} />
            </div>
          ))}

        {turn.citations.length > 0 && (
          <div className="citations">
            <span className="muted small">引用</span>
            {turn.citations.map((c, i) => (
              <CitationCard key={i} c={c} file={store.state.files.find((f) => f.id === c.fileId)} />
            ))}
          </div>
        )}

        {!active && (turn.assistantMessage || turn.status === 'succeeded') && (
          <div className="msg-actions">
            {turn.assistantMessage && <CopyButton text={turn.assistantMessage} />}
            {isLast && turn.status === 'succeeded' && (
              <button className="icon-btn small" aria-label="重新生成" title="重新生成" onClick={() => store.retry(conv.id, turn)}>
                <IconRetry width={15} height={15} />
              </button>
            )}
          </div>
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

function ToolOutput({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const long = text.length > 240 || text.split('\n').length > 4
  return (
    <div className="tool-output">
      <span className="muted">结果</span>
      <div className={'tool-output-text' + (long && !open ? ' clamped' : '')}>{text}</div>
      {long && (
        <button className="link-btn small" onClick={() => setOpen(!open)}>
          {open ? '收起' : '展开全部'}
        </button>
      )}
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="icon-btn small"
      aria-label={copied ? '已复制' : '复制'}
      title={copied ? '已复制' : '复制'}
      onClick={() => {
        void navigator.clipboard?.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? <IconCheck width={15} height={15} /> : <IconCopy width={15} height={15} />}
    </button>
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
      <div className="user-actions">
        <CopyButton text={text} />
      </div>
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
