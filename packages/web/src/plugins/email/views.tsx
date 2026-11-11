import { Check, Copy, Mail, PencilLine, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { copyText } from '../../lib/format'
import { useFlash } from '../../lib/hooks'
import { Button } from '../../ui/button'
import { Input, Textarea } from '../../ui/input'
import type { DraftInput } from '../contracts'
import type { ViewProps } from '../types'

const labels: [keyof DraftInput, string][] = [
  ['to', '收件人'],
  ['subject', '主题'],
  ['body', '正文'],
]

type State = { fields?: DraftInput }

// Nothing is sent from here: the user copies the draft or opens it in their mail app and sends it there, so what
// gets sent is always the version they reviewed.
export function EmailDraftView({ toolInput, viewState, host }: ViewProps<DraftInput, DraftInput, State>) {
  const fields = viewState?.fields ?? toolInput
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(fields)
  const [copied, flash] = useFlash()
  const mailto = `mailto:${encodeURIComponent(fields.to ?? '').replace(/%2C/gi, ',').replace(/%40/g, '@')}?subject=${encodeURIComponent(fields.subject ?? '')}&body=${encodeURIComponent(fields.body ?? '')}`

  return (
    <div className="max-w-xl overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-2.5 text-sm font-medium">
        <Mail className="size-4 text-muted-foreground" /> 邮件草稿
        <span className="ml-auto text-xs font-normal text-muted-foreground">不会自动发送</span>
      </div>
      <dl className="divide-y text-sm">
        {labels.map(([key, label]) => (
          <div key={key} className="flex gap-3 px-4 py-2.5">
            <dt className="w-12 shrink-0 pt-0.5 text-muted-foreground">{label}</dt>
            <dd className="min-w-0 flex-1">
              {!editing ? (
                <span className="break-words whitespace-pre-wrap">{fields[key]}</span>
              ) : key === 'body' ? (
                <Textarea aria-label={label} rows={7} value={draft[key] ?? ''} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
              ) : (
                <Input aria-label={label} value={draft[key] ?? ''} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
              )}
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-2 border-t px-4 py-3">
        {editing ? (
          <>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                host.setViewState({ fields: draft })
                setEditing(false)
              }}
            >
              保存修改
            </Button>
            <Button size="sm" onClick={() => setEditing(false)}>
              放弃修改
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="primary" asChild>
              <a href={mailto}>
                <Mail /> 在邮箱 App 中打开
              </a>
            </Button>
            <Button size="sm" onClick={() => void copyText(`收件人：${fields.to}\n主题：${fields.subject}\n\n${fields.body}`).then((ok) => ok && flash())}>
              {copied ? <Check /> : <Copy />} {copied ? '已复制' : '复制'}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setDraft(fields)
                setEditing(true)
              }}
            >
              <PencilLine /> 修改
            </Button>
            <Button size="sm" variant="ghost" onClick={() => host.sendMessage('请重写这封邮件，语气更正式一些。')}>
              <Sparkles /> 让助手重写
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
