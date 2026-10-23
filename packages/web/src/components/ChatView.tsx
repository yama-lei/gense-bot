import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { liveViews, tools, views } from '../plugins'
import type { DisplayMode, ViewHost } from '../plugins/types'
import { href, navigate } from '../router'
import type { Store } from '../store'
import type { Attachment, BranchNote, Conversation, DriveFile, Effort, ToolCall, Turn, Versions, WebSource } from '../types'
import { modelName, useModels } from '../models'
import { Composer, effortLabel } from './Composer'
import { IconAlert, IconArrowDown, IconBranch, IconCheck, IconChevronDown, IconChevronLeft, IconChevronRight, IconCopy, IconDoc, IconFolder, IconEdit, IconInfo, IconMore, IconRetry, IconSide, IconTool, IconX } from './Icons'
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
  // One panel at a time: opening a side thread closes the plugin panel and the other way round.
  const [sideOpen, setSideOpen] = useState<{ convId: string; id: string } | null>(null)
  const sideId = sideOpen?.convId === conv.id ? sideOpen.id : null
  const setSideId = (id: string | null) => setSideOpen(id ? { convId: conv.id, id } : null)
  const side = sideId ? store.state.conversations.find((c) => c.id === sideId) : undefined
  const sides = store.state.conversations.filter((c) => c.parent?.kind === 'side' && c.parent.chatId === conv.id)
  const parent = conv.parent && store.state.conversations.find((c) => c.id === conv.parent!.chatId)
  const [filesOpen, setFilesOpen] = useState<string | null>(null)
  const showFiles = filesOpen === conv.id
  const openSide = (id: string) => {
    setPanel(null)
    setFilesOpen(null)
    setSideId(id)
  }
  const toggleFiles = () => {
    setPanel(null)
    setSideId(null)
    setFilesOpen(showFiles ? null : conv.id)
  }

  useEffect(() => {
    store.attach(sideId)
    return () => store.attach(null)
  }, [sideId]) // eslint-disable-line react-hooks/exhaustive-deps

  const actions: TurnActions = {
    regenerate: (turn) => store.regenerate(conv.id, turn, model, effort),
    edit: (turn, text) => {
      store.editMessage(conv.id, turn, text, model, effort)
      setAtBottom(true)
    },
    show: (messageId) => store.showVersion(conv.id, messageId),
    fork: (turn) => void store.branch(conv.id, turn, 'fork').then((id) => navigate({ name: 'chat', id }), (e: unknown) => console.error('fork failed', e)),
    side: (turn) => void store.branch(conv.id, turn, 'side').then(openSide, (e: unknown) => console.error('side thread failed', e)),
    openSide,
    busy,
    // Old versions are read-only; a running turn has to finish before history changes.
    canChange: !busy && !conv.viewingOld,
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
        setSideId(null)
        setFilesOpen(null)
      }
      setPanel(mode === 'inline' ? null : { turnId: turn.id, callId: call.id })
    },
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
    <div className={'chat-layout' + (panelCall || side || showFiles ? ' with-panel' : '')}>
      <div className="page chat">
        <TopBar
          right={
            <button className={'icon-btn' + (showFiles ? ' active' : '')} aria-label="会话文件" aria-pressed={showFiles} title="会话文件" onClick={toggleFiles}>
              <IconFolder />
            </button>
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
            {conv.parent?.kind === 'fork' && (
              <div className="fork-banner muted small">
                <IconBranch width={14} height={14} /> 分支自{' '}
                {parent ? <a href={href({ name: 'chat', id: parent.id })}>{parent.title}</a> : '已删除的会话'}
              </div>
            )}
            {conv.turns.length === 0 && !store.turnsLoaded(conv.id) && (
              <div className="page-loading muted">
                <span className="spinner" /> 正在载入会话…
              </div>
            )}
            {conv.turns.map((t) =>
              t.note ? (
                <NoteCard key={t.id} note={t.note} store={store} onOpen={openSide} />
              ) : (
                <TurnView
                  key={t.id}
                  turn={t}
                  store={store}
                  showDetails={showDetails}
                  hostFor={hostFor}
                  actions={actions}
                  sides={sides.filter((c) => c.parent!.messageId === (t.lastMessageId ?? t.id))}
                />
              ),
            )}
          </div>
        </div>

        {!atBottom && (
          <button className="to-bottom" aria-label="回到底部" onClick={() => scrollToBottom()}>
            <IconArrowDown />
          </button>
        )}

        <div className="chat-composer">
          {conv.viewingOld ? (
            <div className="old-version-bar">
              <span>正在查看较早的版本，只读</span>
              <button className="pill-btn" onClick={() => store.showVersion(conv.id, '')}>
                回到当前版本
              </button>
              {last && (
                <button className="pill-btn" onClick={() => actions.fork(last)}>
                  <IconBranch width={15} height={15} /> 从这里分支
                </button>
              )}
            </div>
          ) : (
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
            suggest={suggestions(store, { convId: conv.id, side: !!last && !busy })}
            onClientCommand={(id) => id === 'side' && last && actions.side(last)}
            footnote
          />
          )}
        </div>
      </div>
      {showFiles && <WorkspacePanel store={store} conv={conv} onClose={() => setFilesOpen(null)} />}
      {side && <SideThread store={store} side={side} onClose={() => setSideId(null)} />}
      {panelCall && panelTurn && !side && (
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
  show: (messageId: string) => void
  fork: (turn: Turn) => void
  side: (turn: Turn) => void
  openSide: (sideId: string) => void
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
  sides,
}: {
  turn: Turn
  store: Store
  showDetails: boolean
  hostFor: (t: Turn, c: ToolCall) => ViewHost
  /** Omitted inside a side thread panel, which shows the turns without tree controls. */
  actions?: TurnActions
  sides?: Conversation[]
}) {
  const models = useModels()
  const [processOpen, setProcessOpen] = useState(false)
  const active = turn.status === 'queued' || turn.status === 'running'
  const canChange = actions?.canChange ?? false

  return (
    <section className="turn">
      {turn.attachments?.length ? <AttachmentCards files={turn.attachments} /> : null}
      {turn.command || turn.mentions?.length ? <RefChips turn={turn} /> : null}
      <UserBubble
        text={turn.userMessage}
        versions={actions && turn.userVersions}
        onShow={actions?.show}
        onEdit={canChange ? (text) => actions!.edit(turn, text) : undefined}
        busy={actions?.busy ?? false}
      />

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

        {!active && (turn.assistantMessage || turn.status === 'succeeded' || turn.answerVersions) && (
          <div className="msg-actions">
            {actions && turn.answerVersions && <VersionNav versions={turn.answerVersions} onShow={actions.show} disabled={actions.busy} />}
            {turn.assistantMessage && <CopyButton text={turn.assistantMessage} />}
            {canChange && turn.status === 'succeeded' && (
              <button className="icon-btn small" aria-label="重新生成" title="重新生成" onClick={() => actions!.regenerate(turn)}>
                <IconRetry width={15} height={15} />
              </button>
            )}
            {actions && <MoreMenu turn={turn} actions={actions} />}
          </div>
        )}

        {sides && sides.length > 0 && (
          <div className="side-chips">
            {sides.map((c) => (
              <button key={c.id} className="side-chip" onClick={() => actions?.openSide(c.id)}>
                <IconSide width={14} height={14} /> <span className="ellipsis">{c.title}</span>
              </button>
            ))}
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
      </div>
    </section>
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
                <IconBranch width={15} height={15} /> 分支到新会话
              </span>
            </button>
            {actions.canChange && (
              <button onClick={pick(actions.side)}>
                <span>
                  <IconSide width={15} height={15} /> 开支线
                </span>
              </button>
            )}
          </div>
        </>
      )}
    </span>
  )
}

/** A side thread's summary in the main line; the full text is the note message itself. */
function NoteCard({ note, store, onOpen }: { note: BranchNote; store: Store; onOpen: (sideId: string) => void }) {
  const [open, setOpen] = useState(false)
  const exists = store.state.conversations.some((c) => c.id === note.sideChatId)
  return (
    <section className="turn">
      <div className="note-card">
        <button className="note-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <IconSide width={15} height={15} />
          <span className="ellipsis">支线总结：{note.title}</span>
          <IconChevronRight width={14} height={14} style={{ transform: open ? 'rotate(90deg)' : undefined }} />
        </button>
        {open && <Markdown text={note.summary} />}
        <div className="note-links small">
          {note.fileId && (
            <a href={href({ name: 'files', tab: 'artifact', id: note.fileId })}>
              <IconDoc width={13} height={13} /> {note.fileName ?? '总结文件'}
            </a>
          )}
          {exists && (
            <button className="link-btn" onClick={() => onOpen(note.sideChatId)}>
              打开支线
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

/** A side thread beside its parent: only the turns after the branch point, with its own composer. */
function SideThread({ store, side, onClose }: { store: Store; side: Conversation; onClose: () => void }) {
  const anchor = side.parent!.messageId
  const from = side.turns.findIndex((t) => (t.lastMessageId ?? t.id) === anchor)
  const turns = side.turns.slice(from + 1)
  const last = turns.at(-1)
  const busy = last?.status === 'queued' || last?.status === 'running'
  const [picked, setModel] = useState(side.turns.at(-1)?.model ?? '')
  const model = picked || store.state.prefs.model
  const [effort, setEffort] = useState<Effort>(store.state.prefs.defaultEffort)
  const [summarizing, setSummarizing] = useState(false)
  const [error, setError] = useState('')
  const noHost: ViewHost = {
    callTool: async () => ({ content: '支线面板中不支持界面调用', isError: true }),
    sendMessage: (text) => store.reply(side.id, { text }, model, effort),
    requestDisplayMode: () => {},
    setViewState: () => {},
  }

  const summarize = () => {
    setSummarizing(true)
    setError('')
    store
      .summarizeSide(side.id)
      .then(onClose)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSummarizing(false))
  }

  return (
    <aside className="side-panel side-thread" aria-label="支线">
      <div className="side-panel-head">
        <IconSide width={16} height={16} />
        <strong className="ellipsis">{side.title}</strong>
        <button className="pill-btn" disabled={busy || summarizing || turns.length === 0} onClick={summarize}>
          {summarizing && <span className="spinner" />} 总结回主线
        </button>
        <button className="icon-btn" aria-label="关闭支线" onClick={onClose}>
          <IconX />
        </button>
      </div>
      <div className="side-panel-body">
        <div className="thread">
          {error && (
            <div className="banner error">
              <IconAlert />
              <div>
                <strong>总结失败</strong>
                <p>{error}</p>
              </div>
            </div>
          )}
          {turns.length === 0 && <p className="muted side-empty">在这里追问细节，不会打断主线。聊完后点“总结回主线”，要点会写回主会话。</p>}
          {turns.map((t) => (
            <TurnView key={t.id} turn={t} store={store} showDetails={false} hostFor={() => noHost} />
          ))}
        </div>
      </div>
      <div className="chat-composer">
        <Composer
          placeholder="在支线里追问…"
          model={model}
          effort={effort}
          onModel={setModel}
          onEffort={setEffort}
          busy={busy}
          onStop={() => last && store.stop(side.id, last.id)}
          onSend={(message) => {
            if (turns.length === 0) store.patchConv(side.id, (c) => ({ ...c, title: message.text.replace(/\s+/g, ' ').slice(0, 30) }))
            store.reply(side.id, message, model, effort)
          }}
          onAttach={store.upload}
          suggest={suggestions(store, { convId: side.id })}
        />
      </div>
    </aside>
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
        return (
          <a key={f.id} className="file-card" title={f.name} href={`https://drive.google.com/file/d/${f.id}/view`} target="_blank" rel="noreferrer noopener">
            {body}
          </a>
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
