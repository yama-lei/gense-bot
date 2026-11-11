import { Check, ChevronRight, Copy, FileCode2, FileText, Save } from 'lucide-react'
import { useState } from 'react'
import { Markdown } from '../../features/chat/Markdown'
import { copyText } from '../../lib/format'
import { useFlash } from '../../lib/hooks'
import { Button } from '../../ui/button'
import { Notice } from '../../ui/feedback'
import type { ArtifactInput } from '../contracts'
import type { ViewProps } from '../types'

/** Where the artifact was saved in the chat's workspace. */
type Saved = { path: string }

export function ArtifactView({ toolInput: a, displayMode, viewState, host }: ViewProps<ArtifactInput, ArtifactInput, { saved?: Saved }>) {
  const saved = viewState?.saved
  const [saving, setSaving] = useState(false)
  const [copied, flash] = useFlash()
  const [error, setError] = useState<string | null>(null)
  const Icon = a.type === 'code' ? FileCode2 : FileText

  const save = async () => {
    setSaving(true)
    setError(null)
    const r = await host.callTool('artifact_save', a)
    setSaving(false)
    if (r.isError) setError(r.content)
    else host.setViewState({ saved: r.structuredContent as Saved })
  }

  if (displayMode === 'inline') {
    return (
      <button
        type="button"
        className="flex w-full max-w-md items-center gap-3 rounded-xl border bg-card p-3 text-left transition-colors hover:bg-hover"
        onClick={() => host.requestDisplayMode('panel')}
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{a.title || '未命名'}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {a.type === 'code' ? `代码${a.language ? ` · ${a.language}` : ''}` : '文档'} · {saved ? '已保存' : '未保存'}
          </span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </button>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {saved ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-sm text-success" title={saved.path}>
            <Check className="size-4 shrink-0" />
            <span className="truncate">已保存到 {saved.path.replace(/^\/data\/sessions\/[^/]+\//, '')}</span>
          </span>
        ) : (
          <Button size="sm" disabled={saving} onClick={() => void save()}>
            <Save /> {saving ? '保存中…' : '保存到工作区'}
          </Button>
        )}
        <Button size="sm" onClick={() => void copyText(a.content).then((ok) => ok && flash())}>
          {copied ? <Check /> : <Copy />} {copied ? '已复制' : '复制'}
        </Button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <Markdown text={a.type === 'code' ? '```' + (a.language ?? '') + '\n' + a.content + '\n```' : a.content} />
    </div>
  )
}
