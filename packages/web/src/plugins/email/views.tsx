import { useState } from 'react'
import { IconAlert, IconCopy, IconMail } from '../../components/Icons'
import type { ViewProps } from '../types'
import type { DraftInput } from '../contracts'

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
  const [copied, setCopied] = useState(false)
  const mailto = `mailto:${encodeURIComponent(fields.to).replace(/%2C/gi, ',').replace(/%40/g, '@')}?subject=${encodeURIComponent(fields.subject)}&body=${encodeURIComponent(fields.body)}`

  const copy = () => {
    navigator.clipboard?.writeText(`收件人：${fields.to}\n主题：${fields.subject}\n\n${fields.body}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="confirm-card">
      <div className="confirm-head">
        <IconMail />
        <strong>邮件草稿</strong>
      </div>
      <dl>
        {labels.map(([key, label]) => (
          <div key={key} className="confirm-field">
            <dt>{label}</dt>
            <dd>
              {editing ? (
                <textarea value={draft[key]} rows={key === 'body' ? 6 : 1} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
              ) : (
                <span className="pre">{fields[key]}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className="confirm-consequence">
        <IconAlert width={15} height={15} /> 不会自动发送。请复制，或在邮箱 App 中打开后自己检查并发送。
      </p>
      <div className="confirm-actions">
        {editing ? (
          <>
            <button
              className="btn primary"
              onClick={() => {
                host.setViewState({ fields: draft })
                setEditing(false)
              }}
            >
              保存修改
            </button>
            <button className="btn" onClick={() => setEditing(false)}>
              放弃修改
            </button>
          </>
        ) : (
          <>
            <a className="btn primary" href={mailto}>
              <IconMail width={15} height={15} /> 在邮箱 App 中打开
            </a>
            <button className="btn" onClick={copy}>
              <IconCopy width={15} height={15} /> {copied ? '已复制' : '复制'}
            </button>
            <button className="btn" onClick={() => (setDraft(fields), setEditing(true))}>
              修改
            </button>
            <button className="btn ghost" onClick={() => host.sendMessage('请重写这封邮件，语气更正式一些。')}>
              让助手重写
            </button>
          </>
        )}
      </div>
    </div>
  )
}
