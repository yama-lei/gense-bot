import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MOCK } from '../mode'
import { findModel, modelKey, modelName, useModels } from '../models'
import type { Attachment, DriveFile, Effort, ModelOption } from '../types'
import { IconAlert, IconArrowUp, IconChevronDown, IconDoc, IconPaperclip, IconStop, IconX } from './Icons'

/** Reasoning effort, shown as how hard the model thinks. */
export const effortLabel: Record<Effort, string> = { low: '轻度思考', medium: '标准思考', high: '深度思考' }

const providerLabel = { anthropic: 'Anthropic 端点', openai: 'OpenAI 端点' }

function modelNote(m: ModelOption) {
  if (!m.capabilities) return '能力未知'
  if (!m.capabilities.toolCall) return '不支持工具'
  return `${m.capabilities.context >= 1_000_000 ? m.capabilities.context / 1_000_000 + 'M' : m.capabilities.context / 1000 + 'K'} 上下文`
}

interface Props {
  placeholder: string
  model: string
  effort: Effort
  onModel: (m: string) => void
  onEffort: (e: Effort) => void
  onSend: (text: string, attachments: Attachment[]) => void
  /** Uploads a file to attach; without it the composer takes no files. */
  onAttach?: (file: File) => Promise<DriveFile>
  busy?: boolean
  onStop?: () => void
  autoFocus?: boolean
  leftSlot?: ReactNode
  footnote?: boolean
}

/** A file being attached: uploading, uploaded (with its Drive file) or failed. */
interface Pending {
  key: string
  name: string
  file?: Attachment
  error?: string
}

export function Composer({ placeholder, model, effort, onModel, onEffort, onSend, onAttach, busy, onStop, autoFocus, leftSlot, footnote }: Props) {
  const models = useModels()
  const [text, setText] = useState('')
  const [files, setFiles] = useState<Pending[]>([])
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const uploading = files.some((f) => !f.file && !f.error)
  const ready = files.flatMap((f) => (f.file ? [f.file] : []))

  const attach = (list: Iterable<File>) => {
    if (!onAttach) return
    for (const f of list) {
      const key = crypto.randomUUID()
      setFiles((fs) => [...fs, { key, name: f.name }])
      onAttach(f).then(
        ({ id, name, mimeType, size }) => setFiles((fs) => fs.map((p) => (p.key === key ? { ...p, file: { id, name, mimeType, size } } : p))),
        (e: unknown) => setFiles((fs) => fs.map((p) => (p.key === key ? { ...p, error: e instanceof Error ? e.message : String(e) } : p))),
      )
    }
  }

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 240) + 'px'
  }, [text])

  const send = () => {
    const value = text.trim()
    if ((!value && !ready.length) || busy || uploading) return
    onSend(value || '请看附件。', ready)
    setText('')
    setFiles([])
  }

  return (
    <div className="composer-wrap">
      <div
        className={'composer' + (dragging ? ' dragging' : '')}
        onDragOver={(e) => {
          if (!onAttach || !e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          setDragging(false)
          if (!onAttach || !e.dataTransfer.files.length) return
          e.preventDefault()
          attach(e.dataTransfer.files)
        }}
      >
        {files.length > 0 && (
          <div className="attach-row">
            {files.map((f) => (
              <span key={f.key} className={'attach-chip' + (f.error ? ' error' : '')} title={f.error ?? f.name}>
                {f.error ? <IconAlert width={14} height={14} /> : f.file ? <IconDoc width={14} height={14} /> : <span className="spinner" />}
                <span className="ellipsis">{f.error ?? f.name}</span>
                <button className="icon-btn small" aria-label={`移除 ${f.name}`} onClick={() => setFiles((fs) => fs.filter((p) => p.key !== f.key))}>
                  <IconX width={13} height={13} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          autoFocus={autoFocus}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            if (!onAttach || !e.clipboardData.files.length) return
            e.preventDefault()
            attach(e.clipboardData.files)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
        />
        <div className="composer-row">
          <div className="composer-left">
            {onAttach && (
              <>
                <button className="icon-btn" aria-label="添加文件" title="添加文件（也可以拖放或粘贴），单个不超过 20 MB" onClick={() => picker.current?.click()}>
                  <IconPaperclip width={18} height={18} />
                </button>
                <input
                  ref={picker}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    attach([...(e.target.files ?? [])])
                    e.target.value = ''
                  }}
                />
              </>
            )}
            {leftSlot}
          </div>
          <div className="composer-right">
            <ModelPicker
              value={model}
              onChange={(key) => {
                onModel(key)
                // Keep effort within what the new model supports (models.dev reasoning levels).
                const efforts = findModel(models, key)?.capabilities?.efforts ?? []
                if (efforts.length && !efforts.includes(effort)) onEffort(efforts.at(-1)!)
              }}
            />
            {(findModel(models, model)?.capabilities?.efforts.length ?? 0) > 0 && (
              <Picker
                value={effort}
                options={findModel(models, model)!.capabilities!.efforts.map((e) => ({ value: e, label: effortLabel[e] }))}
                onChange={(v) => onEffort(v as Effort)}
              />
            )}
            {busy ? (
              <button className="send-btn stop" aria-label="停止" onClick={onStop}>
                <IconStop />
              </button>
            ) : (
              <button className="send-btn" aria-label="发送" disabled={(!text.trim() && !ready.length) || uploading} onClick={send}>
                <IconArrowUp />
              </button>
            )}
          </div>
        </div>
      </div>
      {footnote && <p className="footnote">GenseBot 可能出错，请核对重要信息。{MOCK && '当前为 Mock，回复由脚本生成。'}</p>}
    </div>
  )
}

export function Picker({ value, options, onChange, strong }: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; strong?: boolean }) {
  return (
    <label className={'picker' + (strong ? ' strong' : '')}>
      <span>{options.find((o) => o.value === value)?.label ?? value}</span>
      <IconChevronDown width={14} height={14} />
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function ModelPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const models = useModels()
  const current = findModel(models, value)
  return (
    <label className="picker strong" title={current ? modelNote(current) : undefined}>
      <span>{modelName(models, value)}</span>
      {current && !current.capabilities && <span className="tag">能力未知</span>}
      <IconChevronDown width={14} height={14} />
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {(['anthropic', 'openai'] as const).map((p) => (
          <optgroup key={p} label={providerLabel[p]}>
            {models
              .filter((m) => m.provider === p)
              .map((m) => (
                <option key={modelKey(m)} value={modelKey(m)}>
                  {m.name} · {modelNote(m)}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </label>
  )
}
