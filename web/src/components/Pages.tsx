import { useEffect, useRef, useState } from 'react'
import { MOCK } from '../mode'
import { href, navigate } from '../router'
import type { Store } from '../store'
import type { DriveFile, Effort, Project } from '../types'
import { findQuote } from '../util'
import { Composer, Picker, effortLabel } from './Composer'
import { IconAlert, IconDoc, IconPin, IconPlus, IconProject, IconTrash, Spark } from './Icons'
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
  const [model, setModel] = useState(prefs.model)
  const [effort, setEffort] = useState<Effort>(prefs.defaultEffort)
  const [projectId, setProjectId] = useState<string>('')

  return (
    <div className="page home">
      <TopBar />
      <div className="home-center">
        {!store.state.account.driveConnected && <DriveBanner store={store} />}
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
          onSend={(text) => void store.startConversation(text, projectId || null, model, effort).then((id) => navigate({ name: 'chat', id }))}
          leftSlot={<Picker value={projectId} options={[{ value: '', label: '无项目' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]} onChange={setProjectId} />}
        />
        <div className="suggestions">
          {(MOCK
            ? ['读一下奖学金通知，整理时间点', '把周报整理成组会汇报提纲', '帮我给王老师写封邮件', '模拟模型端点错误']
            : ['帮我列一个组会汇报提纲', '解释一下这段代码在做什么']
          ).map((s) => (
            <button key={s} className="chip" onClick={() => void store.startConversation(s, projectId || null, model, effort).then((id) => navigate({ name: 'chat', id }))}>
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
            store.setState((s) => ({ ...s, projects: [...s.projects, { id: 'p-' + Date.now(), name: name.trim(), description: '', pinned: false }] }))
            setName('')
          }}
        >
          <input placeholder="新项目名称" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn primary" disabled={!name.trim()}>
            新建
          </button>
        </form>
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
  const project = store.state.projects.find((p) => p.id === id)
  if (!project) return <NotFound what="项目" />
  const convs = store.state.conversations.filter((c) => c.projectId === id).sort((a, b) => b.updatedAt - a.updatedAt)
  const patch = (fn: (p: Project) => Project) => store.setState((s) => ({ ...s, projects: s.projects.map((p) => (p.id === id ? fn(p) : p)) }))

  return (
    <div className="page">
      <TopBar
        right={
          <button className="pill-btn" onClick={() => patch((p) => ({ ...p, pinned: !p.pinned }))}>
            <IconPin width={15} height={15} /> {project.pinned ? '取消置顶' : '置顶'}
          </button>
        }
      >
        <h2 className="page-title">{project.name}</h2>
      </TopBar>
      <div className="page-body">
        <label className="field">
          <span>项目说明（每次对话都会作为上下文）</span>
          <textarea rows={3} value={project.description} onChange={(e) => patch((p) => ({ ...p, description: e.target.value }))} />
        </label>
        <h3 className="section-title">会话</h3>
        {convs.length === 0 && <p className="muted">还没有会话。在首页选择这个项目后开始对话。</p>}
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
  return (
    <div className="banner warn drive-banner">
      <IconAlert />
      <div>
        <strong>连接 Google Drive</strong>
        <p>资料和 Artifacts 保存在你的 Drive 中（GenseBot/ 文件夹）。连接前，助手不能读取或保存文件。</p>
      </div>
      <button className="pill-btn" onClick={() => store.setDrive(true)}>
        连接
      </button>
    </div>
  )
}

const tabLabel = { source: '资料', artifact: 'Artifacts' } as const

export function FilesView({ store, tab = 'source', id, quote }: { store: Store; tab?: DriveFile['kind']; id?: string; quote?: string }) {
  const { files, account } = store.state
  const list = files.filter((f) => f.kind === tab)
  const file = files.find((f) => f.id === id)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  return (
    <div className="page">
      <TopBar>
        <h2 className="page-title">资料</h2>
      </TopBar>
      <div className="page-body files">
        {!account.driveConnected && <DriveBanner store={store} />}
        <div className={'files-split' + (file ? ' has-preview' : '')}>
          <div className="files-list">
            <div className="tabs" role="tablist">
              {(['source', 'artifact'] as const).map((t) => (
                <a key={t} role="tab" aria-selected={t === tab} className={'tab' + (t === tab ? ' on' : '')} href={href({ name: 'files', tab: t })}>
                  {tabLabel[t]} <span className="muted small">{files.filter((f) => f.kind === t).length}</span>
                </a>
              ))}
            </div>
            {tab === 'source' ? (
              <div className="files-actions">
                <button className="btn primary" disabled={!account.driveConnected || busy} onClick={() => input.current?.click()}>
                  <IconPlus width={15} height={15} /> 上传
                </button>
                <button
                  className="btn"
                  disabled={!account.driveConnected}
                  title="真实版本会打开 Google Picker，只授权你选中的文件"
                  onClick={() => setError('Mock：真实版本会在这里打开 Google Picker。选中的文件只授权给本应用（drive.file）。')}
                >
                  从 Drive 选择
                </button>
                <input
                  ref={input}
                  type="file"
                  accept=".md,.txt,.csv,.json,text/*"
                  hidden
                  onChange={async (e) => {
                    const f = e.target.files?.[0]
                    e.target.value = ''
                    if (!f) return
                    setBusy(true)
                    setError(await store.upload(f))
                    setBusy(false)
                  }}
                />
              </div>
            ) : (
              <p className="muted small">助手生成的产物，保存在 GenseBot/Artifacts/。在会话中点“保存到 Drive”后出现在这里。</p>
            )}
            {error && <p className="notice">{error}</p>}
            <ul className="list doc-list">
              {list.length === 0 && <li className="muted small hint">还没有文件。</li>}
              {list.map((f) => (
                <li key={f.id} className={f.id === id ? 'active' : ''}>
                  <a href={href({ name: 'files', tab, id: f.id })}>
                    <IconDoc width={16} height={16} />
                    <span className="ellipsis">{f.name}</span>
                    <span className="muted small">
                      {formatSize(new Blob([f.content]).size)} · {relTime(f.modifiedTime)}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
          {file && <FilePreview file={file} quote={quote} />}
        </div>
      </div>
    </div>
  )
}

function FilePreview({ file, quote }: { file: DriveFile; quote?: string }) {
  const mark = useRef<HTMLElement>(null)
  const range = quote ? findQuote(file.content, quote) : null
  useEffect(() => {
    mark.current?.scrollIntoView({ block: 'center' })
  }, [file.id, quote])

  return (
    <div className="doc-preview">
      <div className="doc-preview-head">
        <a className="link-btn back" href={href({ name: 'files', tab: file.kind })}>
          ← 全部{tabLabel[file.kind]}
        </a>
        <code className="ellipsis">
          GenseBot/{file.kind === 'source' ? '资料' : 'Artifacts'}/{file.name}
        </code>
      </div>
      {quote && !range && (
        <div className="banner warn quote-missing">
          <IconAlert />
          <div>
            <strong>原文已变化</strong>
            <p>文件中找不到当时引用的内容。引用时保存的摘录：</p>
            <blockquote>{quote}</blockquote>
          </div>
        </div>
      )}
      <pre className="doc-text">
        {range ? (
          <>
            {file.content.slice(0, range[0])}
            <mark ref={mark}>{file.content.slice(range[0], range[1])}</mark>
            {file.content.slice(range[1])}
          </>
        ) : (
          file.content
        )}
      </pre>
    </div>
  )
}

function formatSize(n: number) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`
}

export function ScheduledView({ store }: { store: Store }) {
  return (
    <div className="page">
      <TopBar>
        <h2 className="page-title">定时任务</h2>
      </TopBar>
      <div className="page-body">
        <p className="notice">定时任务属于后续阶段。这里只演示界面，开关只改变浏览器内的 Mock 数据。</p>
        <ul className="list rows">
          {store.state.schedules.map((s) => (
            <li key={s.id} className="row">
              <div className="row-main">
                <strong>{s.name}</strong>
                <span className="muted small">
                  {s.rule} · 下次 {s.enabled ? new Date(s.nextRunAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                </span>
                <span className="muted small">最近：{s.lastResult}</span>
              </div>
              <Toggle
                checked={s.enabled}
                label={s.name}
                onChange={(v) => store.setState((st) => ({ ...st, schedules: st.schedules.map((x) => (x.id === s.id ? { ...x, enabled: v } : x)) }))}
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export function CustomizeView({ store }: { store: Store }) {
  const { plugins, memories, prefs, account } = store.state
  const [memo, setMemo] = useState('')
  return (
    <div className="page">
      <TopBar>
        <h2 className="page-title">定制</h2>
      </TopBar>
      <div className="page-body">
        <h3 className="section-title">Google 账号</h3>
        <ul className="list rows">
          <li className="row">
            <div className="row-main">
              <strong>{account.email}</strong>
              <span className="muted small">{account.driveConnected ? 'Google Drive 已连接 · 只能访问本应用创建或你选择的文件（drive.file）' : 'Google Drive 未连接'}</span>
            </div>
            <button className="btn" onClick={() => store.setDrive(!account.driveConnected)}>
              {account.driveConnected ? '断开' : '连接'}
            </button>
          </li>
        </ul>

        <h3 className="section-title">插件</h3>
        <p className="muted small">每个插件提供一组工具，也可以提供自己的界面。关闭后，助手不能调用它的工具。</p>
        <ul className="list rows">
          {plugins.map((t) => (
            <li key={t.id} className="row">
              <div className="row-main">
                <strong>
                  {t.name} {t.sideEffect && <span className="tag warn">外部写操作</span>} {!t.available && <span className="tag">后续</span>}
                </strong>
                <span className="muted small">{t.description}</span>
              </div>
              <Toggle
                checked={t.enabled}
                disabled={!t.available}
                label={t.name}
                onChange={(v) => store.setState((s) => ({ ...s, plugins: s.plugins.map((x) => (x.id === t.id ? { ...x, enabled: v } : x)) }))}
              />
            </li>
          ))}
        </ul>

        <h3 className="section-title">记忆</h3>
        <p className="muted small">助手在新会话中会应用这些规则。你可以随时修改或删除。</p>
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
          <label className="field">
            <span>回答语言</span>
            <select value={prefs.language} onChange={(e) => store.setState((s) => ({ ...s, prefs: { ...s.prefs, language: e.target.value } }))}>
              <option>中文</option>
              <option>English</option>
            </select>
          </label>
          <label className="field">
            <span>默认 effort</span>
            <select value={prefs.defaultEffort} onChange={(e) => store.setState((s) => ({ ...s, prefs: { ...s.prefs, defaultEffort: e.target.value as Effort } }))}>
              {(['low', 'medium', 'high'] as Effort[]).map((e) => (
                <option key={e} value={e}>
                  {effortLabel[e]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </div>
  )
}

function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={'toggle' + (checked ? ' on' : '')} onClick={() => onChange(!checked)}>
      <span />
    </button>
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
