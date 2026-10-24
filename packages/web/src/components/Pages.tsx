import { useEffect, useRef, useState } from 'react'
import { href, navigate } from '../router'
import type { Store } from '../store'
import type { DriveFile, Effort, Project, ScheduleRule, WebhookInfo } from '../types'
import { findQuote, formatSize } from '../util'
import { Composer, Picker, effortLabel } from './Composer'
import { IconAlert, IconDoc, IconPin, IconPlus, IconProject, IconRetry, IconSearch, IconTrash, Spark } from './Icons'
import { Markdown } from './Markdown'
import { PluginSettings } from './PluginSettings'
import { ModelAccounts } from './ModelAccounts'
import { Select } from './Select'
import { suggestions } from './suggest'
import { TopBar } from './TopBar'

function greeting() {
  const h = new Date().getHours()
  if (h < 6) return '夜深了，还在想什么？'
  if (h < 12) return '早上好，今天先处理什么？'
  if (h < 18) return '下午好，我们来想想什么？'
  return '晚上好，今天还剩什么事？'
}

export function HomeView({ store }: { store: Store }) {
  const { prefs, projects } = store.state
  // Hub state may arrive after mount; until the user picks, follow the current default.
  const [picked, setModel] = useState('')
  const model = picked || prefs.model
  const [effort, setEffort] = useState<Effort>(prefs.defaultEffort)
  const [projectId, setProjectId] = useState<string>('')

  return (
    <div className="page home">
      <TopBar />
      <div className="home-center">
        <DriveBanner store={store} />
        <h1 className="hero">
          <Spark /> {greeting()}
        </h1>
        <Composer
          placeholder="今天需要我帮你做什么？"
          model={model}
          effort={effort}
          onModel={setModel}
          onEffort={setEffort}
          autoFocus
          onSend={(message) => void store.startConversation(message, projectId || null, model, effort).then((id) => navigate({ name: 'chat', id }))}
          onAttach={store.upload}
          suggest={suggestions(store)}
          leftSlot={<Picker label="项目" value={projectId} options={[{ value: '', label: '无项目' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]} onChange={setProjectId} />}
        />
        <div className="suggestions">
          {['帮我列一个组会汇报提纲', '把一段英文摘要翻译成中文', '解释一下什么是 Transformer'].map((s) => (
            <button key={s} className="chip" onClick={() => void store.startConversation({ text: s }, projectId || null, model, effort).then((id) => navigate({ name: 'chat', id }))}>
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export function ProjectsView({ store }: { store: Store }) {
  const [name, setName] = useState('')
  return (
    <div className="page">
      <TopBar>
        <h2 className="page-title">项目</h2>
      </TopBar>
      <div className="page-body">
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim()) return
            const id = 'p-' + Date.now()
            store.setState((s) => ({ ...s, projects: [...s.projects, { id, name: name.trim(), description: '', pinned: false }] }))
            setName('')
            navigate({ name: 'project', id })
          }}
        >
          <input placeholder="新项目名称" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn primary" disabled={!name.trim()}>
            新建
          </button>
        </form>
        {store.state.projects.length === 0 && <p className="muted empty">项目把相关的会话放在一起，并给每次对话附上同一份说明。先新建一个吧。</p>}
        <div className="card-grid">
          {store.state.projects.map((p) => {
            const count = store.state.conversations.filter((c) => c.projectId === p.id).length
            return (
              <a key={p.id} className="card" href={href({ name: 'project', id: p.id })}>
                <div className="card-title">
                  <IconProject /> {p.name}
                  {p.pinned && <IconPin width={14} height={14} className="muted" />}
                </div>
                <p className="muted">{p.description || '暂无说明'}</p>
                <span className="muted small">{count} 个会话</span>
              </a>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function ProjectView({ store, id }: { store: Store; id: string }) {
  const { prefs } = store.state
  const [picked, setModel] = useState('')
  const model = picked || prefs.model
  const [effort, setEffort] = useState<Effort>(prefs.defaultEffort)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const project = store.state.projects.find((p) => p.id === id)
  if (!project) return store.ready ? <NotFound what="项目" /> : <Loading />
  const convs = store.state.conversations.filter((c) => c.projectId === id).sort((a, b) => b.updatedAt - a.updatedAt)
  const patch = (fn: (p: Project) => Project) => store.setState((s) => ({ ...s, projects: s.projects.map((p) => (p.id === id ? fn(p) : p)) }))
  // Chats of a deleted project stay, moved out of it.
  const remove = () => {
    store.setState((s) => ({
      ...s,
      projects: s.projects.filter((p) => p.id !== id),
      conversations: s.conversations.map((c) => (c.projectId === id ? { ...c, projectId: null } : c)),
    }))
    navigate({ name: 'projects' })
  }

  return (
    <div className="page">
      <TopBar
        right={
          <>
            <button className="pill-btn" onClick={() => patch((p) => ({ ...p, pinned: !p.pinned }))}>
              <IconPin width={15} height={15} /> {project.pinned ? '取消置顶' : '置顶'}
            </button>
            <button className={'pill-btn' + (confirmDelete ? ' danger' : '')} onClick={() => (confirmDelete ? remove() : setConfirmDelete(true))} onBlur={() => setConfirmDelete(false)}>
              <IconTrash width={15} height={15} /> {confirmDelete ? '确认删除' : '删除'}
            </button>
          </>
        }
      >
        <input
          key={project.id}
          className="page-title title-edit"
          defaultValue={project.name}
          aria-label="项目名称"
          onBlur={(e) => {
            const name = e.currentTarget.value.trim()
            if (name && name !== project.name) patch((p) => ({ ...p, name }))
            else e.currentTarget.value = project.name
          }}
          onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && e.currentTarget.blur()}
        />
      </TopBar>
      <div className="page-body">
        <Composer
          placeholder={`在「${project.name}」中开始新对话`}
          model={model}
          effort={effort}
          onModel={setModel}
          onEffort={setEffort}
          onSend={(message) => void store.startConversation(message, id, model, effort).then((cid) => navigate({ name: 'chat', id: cid }))}
          onAttach={store.upload}
          suggest={suggestions(store)}
        />
        <label className="field project-desc">
          <span>项目说明</span>
          <textarea
            rows={3}
            placeholder="例如：我是研二学生，这个项目整理组会材料。回答用中文，引用原文。"
            value={project.description}
            onChange={(e) => patch((p) => ({ ...p, description: e.target.value }))}
          />
          <small className="muted">这个项目里的每次对话都会把这段说明发给助手。</small>
        </label>
        <h3 className="section-title">会话</h3>
        {convs.length === 0 && <p className="muted">还没有会话。在上方输入框开始第一个。</p>}
        <ul className="list">
          {convs.map((c) => (
            <li key={c.id}>
              <a href={href({ name: 'chat', id: c.id })}>
                <span className="ellipsis">{c.title}</span>
                <span className="muted small">{relTime(c.updatedAt)}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function DriveBanner({ store }: { store: Store }) {
  const { driveConnected, driveError } = store.state.account
  if (driveConnected && !driveError) return null
  return (
    <div className={'banner drive-banner ' + (driveError ? 'error' : 'warn')}>
      <IconAlert />
      <div>
        <strong>{driveError ? (driveConnected ? 'Google Drive 暂时不可用' : '需要重新连接 Google Drive') : '连接 Google Drive'}</strong>
        <p>{driveError ?? '助手可以读取你 Drive 中的文件；上传的资料和保存的 Artifacts 放在 GenseBot/ 文件夹。连接前，助手不能读取或保存文件。'}</p>
      </div>
      {driveConnected ? (
        <button className="pill-btn" onClick={() => store.refreshFiles()}>
          <IconRetry width={15} height={15} /> 重试
        </button>
      ) : (
        <button className="pill-btn" onClick={() => store.setDrive(true)}>
          连接
        </button>
      )}
    </div>
  )
}

const tabLabel: Record<DriveFile['kind'], string> = { source: '资料', artifact: 'Artifacts', drive: '搜索 Drive' }

export function FilesView({ store, tab = 'source', id, quote }: { store: Store; tab?: DriveFile['kind']; id?: string; quote?: string }) {
  const { files, account } = store.state
  const list = files.filter((f) => f.kind === tab)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<DriveFile[] | null>(null)
  const [searching, setSearching] = useState(false)
  const { refreshFiles } = store

  // Files change in Drive without telling us; reload whenever the page opens.
  useEffect(() => {
    if (account.driveConnected) refreshFiles()
  }, [account.driveConnected]) // eslint-disable-line react-hooks/exhaustive-deps

  const search = async (q: string) => {
    if (!q.trim()) return
    setSearching(true)
    setError(null)
    try {
      setResults(await store.searchDrive(q.trim()))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setSearching(false)
  }

  const shown = tab === 'drive' ? (results ?? []) : list

  return (
    <div className="page">
      <TopBar>
        <h2 className="page-title">资料</h2>
      </TopBar>
      <div className="page-body files">
        <DriveBanner store={store} />
        <div className={'files-split' + (id ? ' has-preview' : '')}>
          <div className="files-list">
            <div className="tabs" role="tablist">
              {(['source', 'artifact', 'drive'] as const).map((t) => (
                <a key={t} role="tab" aria-selected={t === tab} className={'tab' + (t === tab ? ' on' : '')} href={href({ name: 'files', tab: t })}>
                  {tabLabel[t]} {t !== 'drive' && <span className="muted small">{files.filter((f) => f.kind === t).length}</span>}
                </a>
              ))}
            </div>
            {tab === 'source' && (
              <div className="files-actions">
                <button className="btn primary" disabled={!account.driveConnected || busy} onClick={() => input.current?.click()}>
                  {busy ? <span className="spinner" /> : <IconPlus width={15} height={15} />} {busy ? '上传中…' : '上传资料'}
                </button>
                <span className="muted small">PDF、Word、Excel、PPT、图片、文本等，单个不超过 20 MB</span>
                <input
                  ref={input}
                  type="file"
                  multiple
                  hidden
                  onChange={async (e) => {
                    const picked = [...(e.target.files ?? [])]
                    e.target.value = ''
                    if (!picked.length) return
                    setBusy(true)
                    setError(null)
                    const failed: string[] = []
                    for (const f of picked) await store.upload(f).catch((err: unknown) => failed.push(err instanceof Error ? err.message : String(err)))
                    setError(failed.join('\n') || null)
                    setBusy(false)
                  }}
                />
              </div>
            )}
            {tab === 'artifact' && <p className="muted small files-hint">助手生成的产物，保存在 GenseBot/Artifacts/。在会话中点“保存到 Drive”后出现在这里。</p>}
            {tab === 'drive' && (
              <form
                className="search-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  void search(query)
                }}
              >
                <IconSearch width={16} height={16} />
                <input placeholder="搜索文件名或内容" value={query} disabled={!account.driveConnected} onChange={(e) => setQuery(e.target.value)} />
                {searching && <span className="spinner" />}
              </form>
            )}
            {error && <p className="notice">{error}</p>}
            <ul className="list doc-list">
              {shown.length === 0 && (
                <li className="muted small hint">
                  {tab === 'drive'
                    ? results
                      ? `没有找到包含「${query}」的文件。`
                      : '在整个 Google Drive 中按文件名和全文搜索。助手只读取，不会修改 GenseBot/ 以外的文件。'
                    : tab === 'source'
                      ? '还没有资料。上传文本文件，或直接在会话里让助手搜索你的 Drive。'
                      : '还没有保存的 Artifacts。'}
                </li>
              )}
              {shown.map((f) => (
                <li key={f.id} className={f.id === id ? 'active' : ''}>
                  <a href={href({ name: 'files', tab, id: f.id })}>
                    <IconDoc width={16} height={16} />
                    <span className="ellipsis">{f.name}</span>
                    <span className="muted small">{[f.size != null && formatSize(f.size), relTime(f.modifiedTime)].filter(Boolean).join(' · ')}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
          {id && <FilePreview store={store} id={id} tab={tab} quote={quote} />}
        </div>
      </div>
    </div>
  )
}

const folderOf: Record<DriveFile['kind'], string> = { source: 'GenseBot/资料/', artifact: 'GenseBot/Artifacts/', drive: '' }

/** Reads the file's current text from Drive; a citation is highlighted only if the text still contains it. */
function FilePreview({ store, id, tab, quote }: { store: Store; id: string; tab: DriveFile['kind']; quote?: string }) {
  const mark = useRef<HTMLElement>(null)
  const [loaded, setLoaded] = useState<{ id: string; file?: DriveFile; text?: string; error?: string } | null>(null)
  const { readFile } = store
  useEffect(() => {
    let live = true
    readFile(id).then(
      ({ file, text }) => live && setLoaded({ id, file, text }),
      (e: unknown) => live && setLoaded({ id, error: e instanceof Error ? e.message : String(e) }),
    )
    return () => {
      live = false
    }
  }, [id, readFile])
  const current = loaded?.id === id ? loaded : null
  const text = current?.text
  const range = quote && text != null ? findQuote(text, quote) : null
  useEffect(() => {
    mark.current?.scrollIntoView({ block: 'center' })
  }, [text, quote])
  const name = current?.file?.name ?? store.state.files.find((f) => f.id === id)?.name ?? ''
  const [raw, setRaw] = useState(false)
  // Highlighting needs the raw text; otherwise Markdown reads better rendered.
  const markdown = !quote && !raw && current?.file != null && (/\.(md|markdown)$/i.test(current.file.name) || current.file.mimeType === 'application/vnd.google-apps.document')

  return (
    <div className="doc-preview">
      <div className="doc-preview-head">
        <a className="link-btn back" href={href({ name: 'files', tab })}>
          ← 返回
        </a>
        <code className="ellipsis">
          {current?.file ? folderOf[current.file.kind] : ''}
          {name}
        </code>
        {!quote && text != null && current?.file && (/\.(md|markdown)$/i.test(current.file.name) || current.file.mimeType === 'application/vnd.google-apps.document') && (
          <button className="pill-btn open-drive" onClick={() => setRaw(!raw)}>
            {raw ? '预览' : '原文'}
          </button>
        )}
        {(
          <a className="pill-btn open-drive" href={`https://drive.google.com/open?id=${encodeURIComponent(id)}`} target="_blank" rel="noreferrer">
            在 Drive 中打开
          </a>
        )}
      </div>
      {!current && (
        <div className="doc-loading muted">
          <span className="spinner" /> 正在从 Drive 读取…
        </div>
      )}
      {current?.error && (
        <div className="banner error doc-error">
          <IconAlert />
          <div>
            <strong>无法预览</strong>
            <p>{current.error}</p>
          </div>
        </div>
      )}
      {quote && text != null && !range && (
        <div className="banner warn quote-missing">
          <IconAlert />
          <div>
            <strong>原文已变化</strong>
            <p>文件中找不到当时引用的内容。引用时保存的摘录：</p>
            <blockquote>{quote}</blockquote>
          </div>
        </div>
      )}
      {text != null && markdown && (
        <div className="doc-md">
          <Markdown text={text} />
        </div>
      )}
      {text != null && !markdown && (
        <pre className="doc-text">
          {range ? (
            <>
              {text.slice(0, range[0])}
              <mark ref={mark}>{text.slice(range[0], range[1])}</mark>
              {text.slice(range[1])}
            </>
          ) : (
            text || <span className="muted">（空文件）</span>
          )}
        </pre>
      )}
    </div>
  )
}

const when = (at: number | null) =>
  at === null ? '—' : new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const weekdays = ['日', '一', '二', '三', '四', '五', '六']

function ruleText(rule: ScheduleRule) {
  switch (rule.kind) {
    case 'once':
      return `仅一次 · ${when(rule.at)}`
    case 'daily':
      return `每天 ${rule.time}`
    case 'weekly':
      return `每周${[...rule.days].sort().map((d) => weekdays[d]).join('、')} ${rule.time}`
    case 'interval':
      return rule.minutes % 60 === 0 ? `每 ${rule.minutes / 60} 小时` : `每 ${rule.minutes} 分钟`
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Schedules (R49) and webhooks (R50): both send a conversation an Event, which it answers like a message. */
export function ScheduledView({ store }: { store: Store }) {
  const { schedules, webhooks, canCreateWebhooks, conversations } = store.state
  // Conversations that share a title also show when they were last active, so the pickers can tell them apart.
  const label = (c: (typeof conversations)[number]) => c.title || '未命名会话'
  const chats = conversations.map((c) => ({
    value: c.id,
    label: conversations.filter((x) => label(x) === label(c)).length > 1 ? `${label(c)} · ${when(c.updatedAt)}` : label(c),
  }))
  const title = (id: string) => chats.find((c) => c.value === id)?.label ?? '未命名会话'
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="page">
      <TopBar>
        <h2 className="page-title">定时任务</h2>
      </TopBar>
      <div className="page-body">
        <p className="muted small">到点时，任务的内容会作为一条事件发进所选会话，助手像回答消息一样处理它。时区：{tz}</p>
        {error && <p className="notice">{error}</p>}
        {schedules.length > 0 && (
          <ul className="list rows">
            {schedules.map((s) => (
              <li key={s.id} className="row">
                <div className="row-main">
                  <strong>{s.name}</strong>
                  <span className="muted small">
                    <a href={href({ name: 'chat', id: s.treeId })}>{title(s.treeId)}</a> · {ruleText(s.rule)} · 下次 {s.enabled ? when(s.nextRunAt) : '已暂停'}
                  </span>
                  {s.lastRunAt !== null && (
                    <span className={'small ' + (s.lastResult?.startsWith('失败') ? 'error-text' : 'muted')}>
                      上次 {when(s.lastRunAt)}：{s.lastResult}
                    </span>
                  )}
                </div>
                <Toggle checked={s.enabled} label={s.name} onChange={(v) => void store.setScheduleEnabled(s.id, v).catch((e: unknown) => setError(message(e)))} />
                <button className="icon-btn" aria-label={`删除 ${s.name}`} onClick={() => void store.deleteSchedule(s.id).catch((e: unknown) => setError(message(e)))}>
                  <IconTrash width={16} height={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {chats.length ? <ScheduleForm store={store} chats={chats} tz={tz} /> : <p className="muted">先开始一个会话，再为它创建定时任务。</p>}

        <h3 className="section-title">Webhook</h3>
        <p className="muted small">外部服务（CI、监控、表单）用签名的 POST 请求给会话发事件。每个会话一个地址，重新生成会让旧地址失效。</p>
        <WebhookSection store={store} chats={chats} title={title} webhooks={webhooks} canCreate={canCreateWebhooks} />
      </div>
    </div>
  )
}

type Chat = { value: string; label: string }

function ScheduleForm({ store, chats, tz }: { store: Store; chats: Chat[]; tz: string }) {
  const [treeId, setTreeId] = useState(chats[0]!.value)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [kind, setKind] = useState<ScheduleRule['kind']>('daily')
  const [time, setTime] = useState('09:00')
  const [days, setDays] = useState<number[]>([1])
  const [minutes, setMinutes] = useState('60')
  const [at, setAt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chat = chats.some((c) => c.value === treeId) ? treeId : chats[0]!.value

  const rule = (): ScheduleRule => {
    switch (kind) {
      case 'once':
        return { kind, at: new Date(at).getTime() }
      case 'daily':
        return { kind, time }
      case 'weekly':
        return { kind, days, time }
      case 'interval':
        return { kind, minutes: Number(minutes) }
    }
  }
  return (
    <form
      className="schedule-form"
      onSubmit={(e) => {
        e.preventDefault()
        setBusy(true)
        setError(null)
        store
          .createSchedule(chat, { name: name.trim(), prompt: prompt.trim(), rule: rule(), tz })
          .then(() => {
            setName('')
            setPrompt('')
          }, (e: unknown) => setError(message(e)))
          .finally(() => setBusy(false))
      }}
    >
      <h3 className="section-title">新建定时任务</h3>
      <div className="schedule-grid">
        <label className="field">
          <span>名称</span>
          <input value={name} placeholder="例如：每日简报" onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="field">
          <span>发到会话</span>
          <Select label="发到会话" value={chat} options={chats} onChange={setTreeId} />
        </div>
      </div>
      <label className="field">
        <span>内容</span>
        <textarea rows={3} value={prompt} placeholder="例如：汇总今天的待办和日程" onChange={(e) => setPrompt(e.target.value)} />
      </label>
      <div className="schedule-grid">
        <div className="field">
          <span>重复</span>
          <Select
            label="重复"
            value={kind}
            options={[
              { value: 'daily', label: '每天' },
              { value: 'weekly', label: '每周' },
              { value: 'interval', label: '按间隔' },
              { value: 'once', label: '仅一次' },
            ]}
            onChange={(v) => setKind(v as ScheduleRule['kind'])}
          />
        </div>
        {(kind === 'daily' || kind === 'weekly') && (
          <label className="field">
            <span>时间</span>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
        )}
        {kind === 'interval' && (
          <label className="field">
            <span>间隔（分钟，至少 5）</span>
            <input type="number" min={5} step={5} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          </label>
        )}
        {kind === 'once' && (
          <label className="field">
            <span>执行时间</span>
            <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
          </label>
        )}
      </div>
      {kind === 'weekly' && (
        <div className="weekdays" role="group" aria-label="星期">
          {weekdays.map((d, i) => (
            <button
              key={d}
              type="button"
              aria-pressed={days.includes(i)}
              className={'chip' + (days.includes(i) ? ' on' : '')}
              onClick={() => setDays(days.includes(i) ? days.filter((x) => x !== i) : [...days, i])}
            >
              {d}
            </button>
          ))}
        </div>
      )}
      {error && <p className="notice">{error}</p>}
      <div>
        <button className="btn primary" disabled={busy || !name.trim() || !prompt.trim() || (kind === 'once' && !at) || (kind === 'weekly' && !days.length)}>
          创建
        </button>
      </div>
    </form>
  )
}

function WebhookSection({ store, chats, title, webhooks, canCreate }: { store: Store; chats: Chat[]; title: (id: string) => string; webhooks: WebhookInfo[]; canCreate: boolean }) {
  const [treeId, setTreeId] = useState(chats[0]?.value ?? '')
  const [created, setCreated] = useState<{ webhook: WebhookInfo; secret: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const free = chats.filter((c) => !webhooks.some((w) => w.treeId === c.value))
  const chat = free.some((c) => c.value === treeId) ? treeId : free[0]?.value
  const generate = (id: string) => {
    setError(null)
    void store.createWebhook(id).then(setCreated, (e: unknown) => setError(message(e)))
  }
  const url = (w: WebhookInfo) => location.origin + w.path
  return (
    <>
      {error && <p className="notice">{error}</p>}
      {created && <WebhookSecret url={url(created.webhook)} secret={created.secret} onClose={() => setCreated(null)} />}
      {webhooks.length > 0 && (
        <ul className="list rows">
          {webhooks.map((w) => (
            <li key={w.id} className="row">
              <div className="row-main">
                <a href={href({ name: 'chat', id: w.treeId })}>
                  <strong>{title(w.treeId)}</strong>
                </a>
                <code className="small ellipsis">{url(w)}</code>
                <span className="muted small">{w.lastUsedAt ? `上次调用 ${when(w.lastUsedAt)}` : '还没有调用过'}</span>
              </div>
              <button className="btn" title="生成新的地址和密钥，旧的立即失效" disabled={!canCreate} onClick={() => generate(w.treeId)}>
                <IconRetry width={15} height={15} /> 重新生成
              </button>
              <button className="icon-btn" aria-label="删除 Webhook" onClick={() => void store.deleteWebhook(w.id).catch((e: unknown) => setError(message(e)))}>
                <IconTrash width={16} height={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {!canCreate ? (
        <p className="notice">服务器没有配置 TOKEN_ENCRYPTION_KEY，不能生成 Webhook（它的密钥要加密保存）。请管理员配置后重启。</p>
      ) : chat ? (
        <div className="inline-form webhook-new">
          <Select label="会话" value={chat} options={free} onChange={setTreeId} />
          <button className="btn primary" onClick={() => generate(chat)}>
            生成 Webhook
          </button>
        </div>
      ) : (
        !chats.length && <p className="muted">先开始一个会话，再为它生成 Webhook。</p>
      )}
    </>
  )
}

/** The secret is shown only here, once; the server keeps it sealed. */
function WebhookSecret({ url, secret, onClose }: { url: string; secret: string; onClose: () => void }) {
  const example = [
    `BODY='{"title":"部署完成","text":"v1.2 已上线"}'`,
    `TS=$(date +%s)`,
    `SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac '${secret}' | sed 's/^.* //')`,
    `curl -X POST '${url}' \\`,
    `  -H 'content-type: application/json' \\`,
    `  -H "x-gense-timestamp: $TS" -H "x-gense-signature: sha256=$SIG" \\`,
    `  -d "$BODY"`,
  ].join('\n')
  return (
    <div className="webhook-secret">
      <p>
        <strong>密钥只显示这一次</strong>，请现在保存。请求需要带上时间戳和 HMAC-SHA256 签名；可选的 <code>idempotency-key</code> 头能防止重复投递。
      </p>
      <Markdown text={'```sh\n' + example + '\n```'} />
      <button className="btn" onClick={onClose}>
        我已保存
      </button>
    </div>
  )
}

export function CustomizeView({ store }: { store: Store }) {
  const { plugins, skills, memories, prefs, account } = store.state
  const [memo, setMemo] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [pluginError, setPluginError] = useState<string | null>(null)
  const [skillError, setSkillError] = useState<string | null>(null)
  return (
    <div className="page">
      <TopBar>
        <h2 className="page-title">定制</h2>
      </TopBar>
      <div className="page-body">
        <h3 className="section-title">账号</h3>
        <ul className="list rows">
          <li className="row">
            <div className="row-main">
              <strong>{account.email}</strong>
            </div>
            <button className="btn" onClick={() => void store.logout()}>
              退出登录
            </button>
          </li>
        </ul>

        <h3 className="section-title">模型</h3>
        <ModelAccounts store={store} />

        <h3 className="section-title">插件</h3>
        <p className="muted small">每个插件提供一组工具，也可以提供自己的界面。关闭后，助手不能调用它的工具。</p>
        {pluginError && <p className="small error-text">{pluginError}</p>}
        <ul className="list rows">
          {plugins.map((t) => (
            <li key={t.id} className="row plugin-row">
              <div className="row-main">
                <strong>
                  {t.name} {t.sideEffect && <span className="tag warn">外部写操作</span>} {!t.available && <span className="tag">{t.selfHosted ? '仅自部署' : '后续'}</span>}
                </strong>
                <span className="muted small">{t.description}</span>
                {t.available && t.issue && <span className="small warn-text">{t.issue}</span>}
              </div>
              {t.available && t.settings.length > 0 && (
                <button className={'pill-btn' + (editing === t.id ? ' on' : '')} aria-expanded={editing === t.id} onClick={() => setEditing(editing === t.id ? null : t.id)}>
                  设置
                </button>
              )}
              {/* A plugin that is not configured can still be turned off, but not on. */}
              <Toggle
                checked={t.enabled}
                disabled={!t.available || (!t.enabled && !!t.issue)}
                label={t.name}
                onChange={(v) => {
                  setPluginError(null)
                  void store.setPluginEnabled(t.id, v).catch((e: unknown) => setPluginError(e instanceof Error ? e.message : String(e)))
                }}
              />
              {editing === t.id && <PluginSettings key={t.id} plugin={t} store={store} onClose={() => setEditing(null)} />}
            </li>
          ))}
        </ul>

        <div className="section-head">
          <h3 className="section-title">Skills</h3>
        </div>
        <p className="muted small">
          Skill 是一份写给助手的任务说明。任务符合时助手会自动启用它，你也可以在输入框里用 / 指定。关闭后助手不会再使用它。
        </p>
        <ul className="list rows">
          {skills.map((s) => (
            <li key={s.name} className="row">
              <div className="row-main">
                <strong>
                  {s.name} <span className="tag">{s.source === 'builtin' ? '内置' : 'Drive'}</span>
                </strong>
                <span className="muted small">{s.description}</span>
              </div>
              <Toggle
                checked={s.enabled}
                label={s.name}
                onChange={(v) => {
                  setSkillError(null)
                  void store.setSkillEnabled(s.name, v).catch((e: unknown) => setSkillError(e instanceof Error ? e.message : String(e)))
                }}
              />
            </li>
          ))}
        </ul>
        {skillError && <p className="small error-text">{skillError}</p>}
        <ul className="muted small skill-help">
          <li>
            给某个会话加 Skill：让助手在工作区写 <code>skills/&lt;名称&gt;/SKILL.md</code>，开头写上 <code>name</code> 和{' '}
            <code>description</code>（YAML 格式），下面写说明。下一轮起它只在这个会话里生效，和共享 Skill 重名时以它为准。
          </li>
        </ul>

        <h3 className="section-title">记忆</h3>
        <p className="muted small">助手在新会话中会应用这些规则。你可以随时修改或删除。</p>
        {memories.length > 0 && (
          <ul className="list rows">
            {memories.map((m) => (
              <li key={m.id} className="row">
                <input
                  className="row-input"
                  value={m.text}
                  onChange={(e) => store.setState((s) => ({ ...s, memories: s.memories.map((x) => (x.id === m.id ? { ...x, text: e.target.value } : x)) }))}
                />
                <button className="icon-btn" aria-label="删除记忆" onClick={() => store.setState((s) => ({ ...s, memories: s.memories.filter((x) => x.id !== m.id) }))}>
                  <IconTrash width={16} height={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (!memo.trim()) return
            store.setState((s) => ({ ...s, memories: [...s.memories, { id: 'm' + Date.now(), text: memo.trim() }] }))
            setMemo('')
          }}
        >
          <input placeholder="添加一条记忆，例如：周报用三段式" value={memo} onChange={(e) => setMemo(e.target.value)} />
          <button className="btn primary" disabled={!memo.trim()}>
            添加
          </button>
        </form>

        <h3 className="section-title">偏好</h3>
        <div className="prefs">
          <div className="field">
            <span>回答语言</span>
            <Select
              label="回答语言"
              value={prefs.language}
              options={[...Object.entries(languages).map(([value, label]) => ({ value, label })), ...(prefs.language in languages ? [] : [{ value: prefs.language, label: prefs.language }])]}
              onChange={(language) => store.setState((s) => ({ ...s, prefs: { ...s.prefs, language } }))}
            />
          </div>
          <div className="field">
            <span>默认思考强度</span>
            <small className="muted">新会话的初始值；模型不支持时自动忽略</small>
            <Select
              label="默认思考强度"
              value={prefs.defaultEffort}
              options={(['low', 'medium', 'high'] as Effort[]).map((e) => ({ value: e, label: effortLabel[e] }))}
              onChange={(e) => store.setState((s) => ({ ...s, prefs: { ...s.prefs, defaultEffort: e as Effort } }))}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

/** Values are BCP 47 tags; the server passes them to the model as the reply language. */
const languages: Record<string, string> = { 'zh-CN': '简体中文', 'zh-TW': '繁體中文', en: 'English', ja: '日本語' }

function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={'toggle' + (checked ? ' on' : '')} onClick={() => onChange(!checked)}>
      <span />
    </button>
  )
}

export function Loading() {
  return (
    <div className="page">
      <TopBar />
      <div className="page-loading muted">
        <span className="spinner" /> 加载中…
      </div>
    </div>
  )
}

export function NotFound({ what }: { what: string }) {
  return (
    <div className="page">
      <TopBar />
      <div className="page-body">
        <p className="muted">{what}不存在或已删除。</p>
        <a className="btn" href="#/">
          回到首页
        </a>
      </div>
    </div>
  )
}

function relTime(ts: number) {
  const diff = Date.now() - ts
  const m = Math.round(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.round(h / 24)} 天前`
}
