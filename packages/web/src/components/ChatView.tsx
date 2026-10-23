import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { liveViews, tools, views } from '../plugins'
import type { DisplayMode, ViewHost } from '../plugins/types'
import { href, navigate } from '../router'
import type { Store } from '../store'
import type { Attachment, Conversation, DriveFile, Effort, EventData, ToolCall, Turn, Versions, WebSource } from '../types'
import { modelName, useModels } from '../models'
import { Composer, effortLabel } from './Composer'
import { IconAlert, IconArrowDown, IconBranch, IconCheck, IconChevronDown, IconChevronLeft, IconChevronRight, IconClock, IconCopy, IconDoc, IconFolder, IconEdit, IconInfo, IconMore, IconRetry, IconTool, IconX } from './Icons'
import { BranchMap } from './BranchMap'
import { Markdown } from './Markdown'
import { TopBar } from './TopBar'
import { formatSize } from '../util'
import { suggestions } from './suggest'
import { WorkspacePanel } from './WorkspacePanel'

const statusLabel: Record<Turn['status'], string> = {
  queued: '已接收，排队中',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  interrupted: '已中断',
}

export function ChatView({ store, conv }: { store: Store; conv: Conversation }) {
  const last = conv.turns.at(-1)
  // Hub state may arrive after mount; until the user picks, follow the current default.
  const [picked, setModel] = useState(last?.model ?? '')
  const model = picked || store.state.prefs.model
  const [effort, setEffort] = useState<Effort>(last?.effort ?? store.state.prefs.defaultEffort)
  const [showDetails, setShowDetails] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const busy = last?.status === 'queued' || last?.status === 'running'
  const [panel, setPanel] = useState<{ turnId: string; callId: string } | null>(null)
  const panelTurn = panel && conv.turns.find((t) => t.id === panel.turnId)
  const panelCall = panelTurn?.toolCalls.find((c) => c.id === panel!.callId)
  // One panel at a time: opening the file panel closes the plugin panel and the other way round.
  const [filesOpen, setFilesOpen] = useState<string | null>(null)
  const showFiles = filesOpen === conv.id
  const toggleFiles = () => {
    setPanel(null)
    setFilesOpen(showFiles ? null : conv.id)
  }
  const shown = conv.branches?.branches.find((b) => b.id === conv.branchId)
  const main = conv.branches?.branches.find((b) => b.role === 'main')

  const actions: TurnActions = {
    regenerate: (turn) => store.regenerate(conv.id, turn, model, effort),
    edit: (turn, text) => {
      store.editMessage(conv.id, turn, text, model, effort)
      setAtBottom(true)
    },
    show: (branchId) => store.showBranch(conv.id, branchId),
    fork: (turn) => store.fork(conv.id, turn),
    busy,
    // A running turn has to finish before this branch's history branches off.
    canChange: !busy,
  }

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
    sendMessage: (text) => store.reply(conv.id, { text }, model, effort),
    requestDisplayMode: (mode) => {
      if (mode !== 'inline') {
        setFilesOpen(null)
      }
      setPanel(mode === 'inline' ? null : { turnId: turn.id, callId: call.id })
    },
    setViewState: (state) => store.setViewState(conv.id, turn.id, call.id, state),
    readFile: (path) => store.readWorkspaceFile(conv.id, path),
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
    <div className={'chat-layout' + (panelCall || showFiles ? ' with-panel' : '')}>
      <div className="page chat">
        <TopBar
          right={
            <>
              {conv.branches && conv.branchId && <BranchMap state={conv.branches} shown={conv.branchId} onShow={(id) => store.showBranch(conv.id, id)} />}
              <button className={'icon-btn' + (showFiles ? ' active' : '')} aria-label="会话文件" aria-pressed={showFiles} title="会话文件" onClick={toggleFiles}>
                <IconFolder />
              </button>
            </>
          }
        >
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
            {shown && main && shown.role !== 'main' && (
              <div className="fork-banner muted small">
                <IconBranch width={14} height={14} /> 分叉{shown.title ? `「${shown.title}」` : ''}
                <button className="link-btn" onClick={() => store.showBranch(conv.id, main.id)}>
                  返回主线
                </button>
                {shown.role === 'user' && (
                  <button
                    className="link-btn"
                    disabled={shown.status === 'running' || conv.turns.length === 0}
                    title="让这个分叉整理出结论，交给主线"
                    onClick={() => store.summarize(conv.id)}
                  >
                    总结给主线
                  </button>
                )}
              </div>
            )}
            {conv.turns.length === 0 && !store.turnsLoaded(conv.id) && (
              <div className="page-loading muted">
                <span className="spinner" /> 正在载入会话…
              </div>
            )}
            {conv.turns.map((t) => (
              <TurnView key={t.id} turn={t} store={store} showDetails={showDetails} hostFor={hostFor} actions={actions} />
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
            onSend={(message) => {
              store.reply(conv.id, message, model, effort)
              setAtBottom(true)
            }}
            onAttach={store.upload}
            suggest={suggestions(store, { convId: conv.id })}
            footnote
          />
        </div>
      </div>
      {showFiles && <WorkspacePanel store={store} conv={conv} onClose={() => setFilesOpen(null)} />}
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

/** Web pages the turn used, like ChatGPT's "Sources" pill: stacked site badges that open a list. */
function Sources({ sources }: { sources: WebSource[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="sources">
      <button className="sources-pill" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="site-stack">
          {sources.slice(0, 3).map((s) => (
            <SiteBadge key={s.url} site={s.site} />
          ))}
        </span>
        来源 · {sources.length}
      </button>
      {open && (
        <ol className="source-list">
          {sources.map((s) => (
            <li key={s.url}>
              <a href={s.url} target="_blank" rel="noreferrer noopener">
                <span className="source-site">
                  <SiteBadge site={s.site} /> {s.site}
                </span>
                <span className="source-title">{s.title}</span>
              </a>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

/** First letter of the site on a colour derived from its name; no favicon requests leave the page. */
function SiteBadge({ site }: { site: string }) {
  let h = 0
  for (const ch of site) h = (h * 31 + ch.charCodeAt(0)) % 360
  return (
    <span className="site-badge" style={{ background: `hsl(${h} 45% 45%)` }} aria-hidden>
      {site.replace(/^www\./, '').charAt(0).toUpperCase()}
    </span>
  )
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

interface TurnActions {
  regenerate: (turn: Turn) => void
  edit: (turn: Turn, text: string) => void
  /** Shows another branch, a version of a message. */
  show: (branchId: string) => void
  fork: (turn: Turn) => void
  /** A turn is running; versions stay put until it settles. */
  busy: boolean
  canChange: boolean
}

function TurnView({
  turn,
  store,
  showDetails,
  hostFor,
  actions,
}: {
  turn: Turn
  store: Store
  showDetails: boolean
  hostFor: (t: Turn, c: ToolCall) => ViewHost
  actions?: TurnActions
}) {
  const models = useModels()
  const [processOpen, setProcessOpen] = useState(false)
  const active = turn.status === 'queued' || turn.status === 'running'
  // An Event or a brief is not the user's message: it has no versions to edit or ask again.
  const own = !turn.event && turn.brief === undefined
  const canChange = (actions?.canChange ?? false) && own
  // An Event that did not wake the conversation has no answer of its own; the next turn reads it.
  const passive = !!turn.event && !turn.assistantMessage && turn.toolCalls.length === 0 && turn.status === 'succeeded'

  return (
    <section className="turn">
      {turn.attachments?.length ? <AttachmentCards files={turn.attachments} /> : null}
      {turn.command || turn.mentions?.length ? <RefChips turn={turn} /> : null}
      {turn.event ? (
        <EventCard event={turn.event} queued={turn.status === 'queued'} />
      ) : turn.brief !== undefined ? (
        <div className="brief-line muted small">
          <IconBranch width={14} height={14} /> {turn.brief}
        </div>
      ) : (
        <UserBubble
          text={turn.userMessage}
          versions={actions && turn.userVersions}
          onShow={actions?.show}
          onEdit={canChange ? (text) => actions!.edit(turn, text) : undefined}
          busy={actions?.busy ?? false}
        />
      )}

      {showDetails && (
        <div className="turn-details">
          <span>请求 {turn.requestId}</span>
          <span>{modelName(models, turn.model)}</span>
          <span>{effortLabel[turn.effort]}</span>
          <span>{new Date(turn.createdAt).toLocaleString('zh-CN')}</span>
          <span className={'status-chip ' + turn.status}>{statusLabel[turn.status]}</span>
        </div>
      )}

      {!passive && <div className="assistant">
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
          .filter((c) => c.resourceUri && c.origin === 'model' && (c.status === 'succeeded' || (c.status === 'running' && liveViews.has(c.resourceUri))))
          .map((c) => (
            <div key={c.id} className="plugin-slot">
              <PluginSlot call={c} displayMode="inline" host={hostFor(turn, c)} />
            </div>
          ))}

        {turn.sources && turn.sources.length > 0 && <Sources sources={turn.sources} />}

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
            {canChange && turn.status === 'succeeded' && (
              <button className="icon-btn small" aria-label="重新生成" title="重新生成" onClick={() => actions!.regenerate(turn)}>
                <IconRetry width={15} height={15} />
              </button>
            )}
            {actions && <MoreMenu turn={turn} actions={actions} />}
          </div>
        )}

        {turn.status === 'failed' && (
          <div className="banner error">
            <IconAlert />
            <div>
              <strong>任务失败</strong>
              <p>{turn.error}</p>
            </div>
            {canChange && (
              <button className="pill-btn" onClick={() => actions!.regenerate(turn)}>
                <IconRetry width={15} height={15} /> 重试
              </button>
            )}
          </div>
        )}
        {turn.status === 'interrupted' && (
          <div className="banner warn">
            <IconInfo />
            <div>
              <strong>已中断</strong>
              <p>已产生的内容保留；未完成的工具调用不会自动重跑。</p>
            </div>
            {canChange && (
              <button className="pill-btn" onClick={() => actions!.regenerate(turn)}>
                <IconRetry width={15} height={15} /> 重新提交
              </button>
            )}
          </div>
        )}
      </div>}
    </section>
  )
}

const eventSource: Record<EventData['source']['kind'], string> = { branch: '分叉', agent: '子代理', schedule: '定时任务', webhook: 'Webhook', system: '系统' }

/** An Event in the transcript (R46): where it came from and its title, opening to its body. */
function EventCard({ event, queued }: { event: EventData; queued: boolean }) {
  const [open, setOpen] = useState(false)
  const Icon = event.source.kind === 'schedule' ? IconClock : event.source.kind === 'webhook' ? IconTool : event.source.kind === 'system' ? IconInfo : IconBranch
  const from = event.source.kind === 'webhook' || event.source.kind === 'system' ? eventSource[event.source.kind] : `${eventSource[event.source.kind]}「${event.source.label}」`
  return (
    <div className={'event-card' + (open ? ' open' : '')}>
      <button className="event-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon width={16} height={16} />
        <span className="event-from muted small">{from}</span>
        <strong className="ellipsis">{event.title}</strong>
        {queued ? <span className="tag">排队中</span> : !event.wake && <span className="tag">未打断对话</span>}
        <span className="muted small event-time">{new Date(event.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
        <IconChevronRight width={14} height={14} style={{ transform: open ? 'rotate(90deg)' : undefined }} />
      </button>
      {open && event.body && (
        <div className="event-body">
          <Markdown text={event.body} />
        </div>
      )}
    </div>
  )
}

/** "‹ 2 / 3 ›" between sibling versions of a message. */
function VersionNav({ versions, onShow, disabled }: { versions: Versions; onShow: (id: string) => void; disabled?: boolean }) {
  const { ids, index } = versions
  return (
    <span className="version-nav">
      <button className="icon-btn small" aria-label="上一个版本" disabled={disabled || index === 0} onClick={() => onShow(ids[index - 1])}>
        <IconChevronLeft width={15} height={15} />
      </button>
      <span className="small">
        {index + 1} / {ids.length}
      </span>
      <button className="icon-btn small" aria-label="下一个版本" disabled={disabled || index === ids.length - 1} onClick={() => onShow(ids[index + 1])}>
        <IconChevronRight width={15} height={15} />
      </button>
    </span>
  )
}

function MoreMenu({ turn, actions }: { turn: Turn; actions: TurnActions }) {
  const [open, setOpen] = useState(false)
  const pick = (fn: (t: Turn) => void) => () => {
    setOpen(false)
    fn(turn)
  }
  return (
    <span className="more-menu">
      <button className="icon-btn small" aria-label="更多" title="更多" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <IconMore width={15} height={15} />
      </button>
      {open && (
        <>
          <div className="menu-scrim" onClick={() => setOpen(false)} />
          <div className="menu up" role="menu">
            <button onClick={pick(actions.fork)}>
              <span>
                <IconBranch width={15} height={15} /> 从这里分叉
              </span>
            </button>
          </div>
        </>
      )}
    </span>
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

/** Files sent with a user message, shown above its bubble; each opens in Drive. */
function AttachmentCards({ files }: { files: Attachment[] }) {
  return (
    <div className="user-files">
      {files.map((f) => {
        const body = (
          <>
            <IconDoc width={18} height={18} />
            <span className="ellipsis">{f.name}</span>
            {f.size != null && <span className="muted">{formatSize(f.size)}</span>}
          </>
        )
        // Attachments live in the chat's workspace (`f.id` is the path); the file panel opens them.
        return (
          <span key={f.id} className="file-card" title={f.id}>
            {body}
          </span>
        )
      })}
    </div>
  )
}

/** The command and mentions a user message was sent with. */
function RefChips({ turn }: { turn: Turn }) {
  return (
    <div className="user-files">
      {turn.command && (
        <span className="ref-chip" title="命令">
          <span className="ellipsis">/{turn.command.label}</span>
        </span>
      )}
      {turn.mentions?.map((m) => (
        <span key={m.kind + m.id} className="ref-chip" title={m.kind === 'chat' ? '会话' : '插件'}>
          <span className="ellipsis">@{m.label}</span>
        </span>
      ))}
    </div>
  )
}

function UserBubble({
  text,
  versions,
  onShow,
  onEdit,
  busy,
}: {
  text: string
  versions?: Versions
  onShow?: (id: string) => void
  /** Present when the message may be edited now. */
  onEdit?: (text: string) => void
  busy: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  useLayoutEffect(() => {
    if (ref.current) setOverflow(ref.current.scrollHeight > 300)
  }, [text])

  if (draft != null)
    return (
      <div className="user-row">
        <div className="edit-box">
          <textarea
            value={draft}
            autoFocus
            aria-label="编辑消息"
            rows={Math.min(10, draft.split('\n').length + 1)}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setDraft(null)
            }}
          />
          <div className="edit-actions">
            <button className="pill-btn" onClick={() => setDraft(null)}>
              取消
            </button>
            <button
              className="pill-btn primary"
              disabled={!draft.trim() || draft.trim() === text.trim() || !onEdit}
              onClick={() => {
                onEdit?.(draft.trim())
                setDraft(null)
              }}
            >
              发送
            </button>
          </div>
        </div>
      </div>
    )

  return (
    <div className="user-row">
      <div className={'user-actions' + (versions ? ' versioned' : '')}>
        {versions && onShow && <VersionNav versions={versions} onShow={onShow} disabled={busy} />}
        <CopyButton text={text} />
        {onEdit && (
          <button className="icon-btn small" aria-label="编辑" title="编辑" onClick={() => setDraft(text)}>
            <IconEdit width={15} height={15} />
          </button>
        )}
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
