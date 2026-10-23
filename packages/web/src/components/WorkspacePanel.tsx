import { useEffect, useState } from 'react'
import type { Store } from '../store'
import type { Conversation, WorkspaceFile, WorkspacePreview } from '../types'
import { formatSize } from '../util'
import { IconChevronLeft, IconDoc, IconTrash, IconX } from './Icons'

const sections = [
  { root: '/workspace', label: '工作区', hint: '本会话的文件，助手可以读写' },
  { root: '/skills', label: '共享 Skill', hint: '只读，来自设置里启用的 Skill' },
]

/** The chat's workspace (roadmap-2 "L0-6 会话工作区"): file list, preview, download and delete. */
export function WorkspacePanel({ store, conv, onClose }: { store: Store; conv: Conversation; onClose: () => void }) {
  const [open, setOpen] = useState<WorkspaceFile | null>(null)
  const files = conv.files ?? []

  useEffect(() => {
    store.refreshWorkspace(conv.id)
  }, [conv.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // The file may be deleted by the assistant or the user while it is open.
  const current = open && files.find((f) => f.path === open.path)

  return (
    <aside className="side-panel workspace-panel" aria-label="会话文件">
      <div className="side-panel-head">
        {current && (
          <button className="icon-btn" aria-label="返回文件列表" onClick={() => setOpen(null)}>
            <IconChevronLeft />
          </button>
        )}
        <strong className="ellipsis">{current ? current.path : '文件'}</strong>
        <button className="icon-btn" aria-label="关闭文件面板" onClick={onClose}>
          <IconX />
        </button>
      </div>
      <div className="side-panel-body">
        {current ? (
          // Keyed by mtime so a rewrite by the assistant reloads the preview.
          <FilePreview key={current.path + current.mtime} store={store} convId={conv.id} file={current} onDeleted={() => setOpen(null)} />
        ) : (
          sections.map((s) => {
            const list = files.filter((f) => f.path.startsWith(s.root + '/'))
            return (
              <section key={s.root} className="ws-section">
                <div className="ws-section-head">
                  <span>{s.label}</span>
                  <code className="muted small">{s.root}</code>
                </div>
                <p className="muted small ws-hint">{s.hint}</p>
                {list.length === 0 ? (
                  <p className="muted small ws-empty">{s.root === '/workspace' ? '还没有文件。让助手“记下来”或“写成文件”，它会保存在这里。' : '没有启用的 Skill。'}</p>
                ) : (
                  <ul className="ws-list">
                    {list.map((f) => (
                      <li key={f.path}>
                        <button className="ws-row" onClick={() => setOpen(f)} title={f.path}>
                          <IconDoc width={16} height={16} />
                          <span className="ws-name ellipsis">{f.path.slice(s.root.length + 1)}</span>
                          <span className="muted small">{formatSize(f.size)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )
          })
        )}
      </div>
    </aside>
  )
}

function FilePreview({ store, convId, file, onDeleted }: { store: Store; convId: string; file: WorkspaceFile; onDeleted: () => void }) {
  const [preview, setPreview] = useState<WorkspacePreview | null>(null)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    let live = true
    store.workspacePreview(convId, file.path).then(
      (p) => live && setPreview(p),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    )
    return () => {
      live = false
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const remove = () => {
    if (!confirm(`删除 ${file.path}？此操作不能撤销。`)) return
    setDeleting(true)
    store.deleteWorkspaceFile(convId, file.path).then(onDeleted, (e: unknown) => {
      setError(e instanceof Error ? e.message : String(e))
      setDeleting(false)
    })
  }

  const name = file.path.slice(file.path.lastIndexOf('/') + 1)
  return (
    <div className="ws-preview">
      <div className="artifact-actions">
        <span className="muted small ws-meta">
          {formatSize(file.size)} · {new Date(file.mtime).toLocaleString()}
          {file.readOnly && ' · 只读'}
        </span>
        <a className="pill-btn small" href={store.workspaceFileUrl(convId, file.path)} download={name}>
          下载
        </a>
        {!file.readOnly && (
          <button className="pill-btn small danger" onClick={remove} disabled={deleting}>
            <IconTrash width={14} height={14} /> {deleting ? '删除中…' : '删除'}
          </button>
        )}
      </div>
      {error ? (
        <p className="ws-note error-text">{error}</p>
      ) : !preview ? (
        <p className="ws-note muted">
          <span className="spinner" /> 正在读取…
        </p>
      ) : preview.binary ? (
        <p className="ws-note muted">二进制文件，不能预览，请下载查看。</p>
      ) : (
        <>
          <pre className="ws-text">{preview.text}</pre>
          {preview.truncated && <p className="ws-note muted small">只显示了开头 {formatSize(preview.text.length)}，完整内容请下载。</p>}
        </>
      )}
    </div>
  )
}
