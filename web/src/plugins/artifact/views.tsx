import { useState } from 'react'
import { IconCheck, IconCopy, IconDoc } from '../../components/Icons'
import { Markdown } from '../../components/Markdown'
import { href } from '../../router'
import type { ViewProps } from '../types'
import type { ArtifactInput } from './tools'

type Saved = { fileId: string; name: string }

export function ArtifactView({ toolInput, displayMode, viewState, host }: ViewProps<ArtifactInput, ArtifactInput, { saved?: Saved }>) {
  const a = toolInput
  const saved = viewState?.saved
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)

  const save = async () => {
    setSaving(true)
    const r = await host.callTool('artifact.save', a)
    setSaving(false)
    if (!r.isError) host.setViewState({ saved: r.structuredContent as Saved })
  }

  if (displayMode === 'inline') {
    return (
      <button className="artifact-card" onClick={() => host.requestDisplayMode('panel')}>
        <span className="artifact-icon">
          <IconDoc />
        </span>
        <span className="artifact-meta">
          <strong className="ellipsis">{a.title}</strong>
          <span className="muted small">{a.type === 'code' ? `代码 · ${a.language ?? ''}` : '文档'} · {saved ? '已保存到 Drive' : '未保存'}</span>
        </span>
        <span className="muted small">打开</span>
      </button>
    )
  }

  return (
    <div className="artifact-full">
      <div className="artifact-actions">
        {saved ? (
          <a className="pill-btn" href={href({ name: 'files', tab: 'artifact', id: saved.fileId })}>
            <IconCheck width={15} height={15} /> 已保存 · 查看
          </a>
        ) : (
          <button className="pill-btn" disabled={saving} onClick={save}>
            {saving ? '保存中…' : '保存到 Drive'}
          </button>
        )}
        <button
          className="pill-btn"
          onClick={() => {
            navigator.clipboard?.writeText(a.content)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          <IconCopy width={15} height={15} /> {copied ? '已复制' : '复制'}
        </button>
      </div>
      <div className="artifact-body">
        <Markdown text={a.type === 'code' ? '```' + (a.language ?? '') + '\n' + a.content + '\n```' : a.content} />
      </div>
    </div>
  )
}
