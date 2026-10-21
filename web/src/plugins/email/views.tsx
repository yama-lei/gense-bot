import { useState } from 'react'
import { IconAlert, IconCheck, IconMail } from '../../components/Icons'
import type { ViewProps } from '../types'
import type { DraftInput } from './tools'

const labels: [keyof DraftInput, string][] = [
  ['to', '收件人'],
  ['subject', '主题'],
  ['body', '正文'],
]

type State = { fields?: DraftInput; savedDraftId?: string }

// Saving to the Drafts folder is the only action; the user sends from their mail app,
// so what gets sent is always the version they reviewed (docs/design/architecture.md "smail").
export function EmailDraftView({ toolInput, viewState, host }: ViewProps<DraftInput, DraftInput, State>) {
  const fields = viewState?.fields ?? toolInput
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(fields)
  const [saving, setSaving] = useState(false)
  const saved = viewState?.savedDraftId

  const save = async () => {
    setSaving(true)
    const r = await host.callTool('email.saveDraft', fields)
    setSaving(false)
    if (!r.isError) host.setViewState({ fields, savedDraftId: (r.structuredContent as { draftId: string }).draftId })
  }

  return (
    <div className={'confirm-card' + (saved ? ' confirmed' : '')}>
      <div className="confirm-head">
        <IconMail />
        <strong>邮件草稿</strong>
        {saved && <span className="status-chip succeeded">已存入草稿箱（Mock）</span>}
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
        <IconAlert width={15} height={15} /> 只写入 smail 草稿箱，不会发送。请在邮箱 App 中检查后自己发送。
      </p>
      <div className="confirm-actions">
        {editing ? (
          <>
            <button
              className="btn primary"
              onClick={() => {
                // An edited draft is a new version: it must be saved again.
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
            {!saved && (
              <button className="btn primary" disabled={saving} onClick={save}>
                <IconCheck width={15} height={15} /> {saving ? '写入中…' : '存入草稿箱'}
              </button>
            )}
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
