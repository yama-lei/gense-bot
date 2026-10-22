import { useEffect, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { toOutgoingCommand, type Command } from '../commands'
import { MOCK } from '../mode'
import { findModel, modelKey, modelName, useModels } from '../models'
import type { Attachment, DriveFile, Effort, Mention, ModelOption, Outgoing } from '../types'
import { IconAlert, IconArrowUp, IconChevronDown, IconDoc, IconPaperclip, IconStop, IconX } from './Icons'
import type { MentionOption, Suggestions } from './suggest'

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
  onSend: (message: Outgoing) => void
  /** Uploads a file to attach; without it the composer takes no files. */
  onAttach?: (file: File) => Promise<DriveFile>
  /** Candidates for the `/` and `@` menus; without them typing `/` or `@` opens nothing. */
  suggest?: Suggestions
  /** Runs a client command (such as 开支线) picked from the `/` menu. */
  onClientCommand?: (id: string) => void
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

/** Items per group in the `@` menu. */
const GROUP_SIZE = 5
const groupLabel: Record<MentionOption['kind'], string> = { plugin: '插件', file: '资料文件', chat: '会话' }

type MenuItem = { kind: 'command'; command: Command } | { kind: 'mention'; option: MentionOption }

/** The `/` or `@` being typed before the caret, if any. */
function triggerAt(text: string, caret: number, commandSet: boolean) {
  const before = text.slice(0, caret)
  const slash = /^\/(\S*)$/.exec(before)
  if (slash && !commandSet) return { kind: '/' as const, query: slash[1], start: 0 }
  const at = /(^|\s)@(\S*)$/.exec(before)
  if (at) return { kind: '@' as const, query: at[2], start: before.length - at[2].length - 1 }
  return null
}

function menuItems(suggest: Suggestions, trigger: NonNullable<ReturnType<typeof triggerAt>>): MenuItem[] {
  const q = trigger.query.toLowerCase()
  const hit = (...s: (string | undefined)[]) => !q || s.some((x) => x?.toLowerCase().includes(q))
  if (trigger.kind === '/') return suggest.commands.filter((c) => hit(c.label, c.hint, c.id)).map((command) => ({ kind: 'command', command }))
  return (['plugin', 'file', 'chat'] as const).flatMap((kind) =>
    suggest.mentions
      .filter((m) => m.kind === kind && hit(m.label))
      .slice(0, GROUP_SIZE)
      .map((option): MenuItem => ({ kind: 'mention', option })),
  )
}

export function Composer({ placeholder, model, effort, onModel, onEffort, onSend, onAttach, suggest, onClientCommand, busy, onStop, autoFocus, leftSlot, footnote }: Props) {
  const models = useModels()
  const [text, setText] = useState('')
  const [files, setFiles] = useState<Pending[]>([])
  const [command, setCommand] = useState<Command | null>(null)
  const [mentions, setMentions] = useState<Mention[]>([])
  const [caret, setCaret] = useState(0)
  const [focused, setFocused] = useState(!!autoFocus)
  // The trigger closed with Esc stays closed until the text before the caret changes.
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const uploading = files.some((f) => !f.file && !f.error)
  const ready = files.flatMap((f) => (f.file ? [f.file] : []))

  const trigger = suggest && focused ? triggerAt(text, caret, !!command) : null
  const triggerKey = trigger && `${trigger.start}:${text.slice(0, caret)}`
  const items = trigger && triggerKey !== dismissed ? menuItems(suggest!, trigger) : []
  const current = Math.min(active, Math.max(items.length - 1, 0))

  const pick = (item: MenuItem) => {
    if (!trigger) return
    const rest = text.slice(0, trigger.start) + text.slice(caret)
    // Render the shortened text first, so the caret lands where the trigger was.
    flushSync(() => setText(rest))
    ref.current?.setSelectionRange(trigger.start, trigger.start)
    setCaret(trigger.start)
    setActive(0)
    if (item.kind === 'command') {
      if (item.command.client) onClientCommand?.(item.command.id)
      else setCommand(item.command)
      return
    }
    const o = item.option
    if (o.kind === 'file') {
      if (!files.some((f) => f.file?.id === o.id)) setFiles((fs) => [...fs, { key: o.id, name: o.label, file: o.file }])
    } else if (!mentions.some((m) => m.kind === o.kind && m.id === o.id)) setMentions((ms) => [...ms, { kind: o.kind as Mention['kind'], id: o.id, label: o.label }])
  }

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

  const canSend = (!!text.trim() || ready.length > 0 || !!command) && !uploading
  const send = () => {
    const value = text.trim()
    if (!canSend || busy) return
    onSend({
      text: value || (command ? command.label : '请看附件。'),
      attachments: ready.length ? ready : undefined,
      command: command ? toOutgoingCommand(command) : undefined,
      mentions: mentions.length ? mentions : undefined,
    })
    setText('')
    setFiles([])
    setCommand(null)
    setMentions([])
  }
  const syncCaret = (el: HTMLTextAreaElement) => setCaret(el.selectionStart)

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
        {items.length > 0 && (
          <div className="suggest-menu" role="listbox" aria-label={trigger!.kind === '/' ? '命令' : '提及'} onMouseDown={(e) => e.preventDefault()}>
            {items.map((item, i) => {
              const group = item.kind === 'mention' && (i === 0 || (items[i - 1] as { option?: MentionOption }).option?.kind !== item.option.kind) ? groupLabel[item.option.kind] : null
              const [label, hint] = item.kind === 'command' ? ['/' + item.command.label, item.command.hint] : [item.option.label, item.option.hint]
              return (
                <div key={item.kind === 'command' ? item.command.id : `${item.option.kind}:${item.option.id}`}>
                  {group && <div className="suggest-group">{group}</div>}
                  <button role="option" aria-selected={i === current} className={'suggest-item' + (i === current ? ' active' : '')} onMouseEnter={() => setActive(i)} onClick={() => pick(item)}>
                    <span className="ellipsis">{label}</span>
                    {hint && <span className="muted small ellipsis">{hint}</span>}
                  </button>
                </div>
              )
            })}
          </div>
        )}
        {(files.length > 0 || command || mentions.length > 0) && (
          <div className="attach-row">
            {command && (
              <span className="attach-chip command" title={command.hint}>
                <span className="ellipsis">/{command.label}</span>
                <button className="icon-btn small" aria-label={`移除命令 ${command.label}`} onClick={() => setCommand(null)}>
                  <IconX width={13} height={13} />
                </button>
              </span>
            )}
            {mentions.map((m) => (
              <span key={m.kind + m.id} className="attach-chip mention" title={m.kind === 'chat' ? '会话' : '插件'}>
                <span className="ellipsis">@{m.label}</span>
                <button className="icon-btn small" aria-label={`移除提及 ${m.label}`} onClick={() => setMentions((ms) => ms.filter((x) => x !== m))}>
                  <IconX width={13} height={13} />
                </button>
              </span>
            ))}
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
          onChange={(e) => {
            setText(e.target.value)
            syncCaret(e.target)
          }}
          onSelect={(e) => syncCaret(e.currentTarget)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onPaste={(e) => {
            if (!onAttach || !e.clipboardData.files.length) return
            e.preventDefault()
            attach(e.clipboardData.files)
          }}
          onKeyDown={(e) => {
            if (items.length && !e.nativeEvent.isComposing) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((current + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length)
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                pick(items[current])
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setDismissed(triggerKey)
                return
              }
            }
            if (e.key === 'Backspace' && !text && caret === 0) {
              // Like ChatGPT: backspace in an empty box removes the last chip.
              if (mentions.length) setMentions((ms) => ms.slice(0, -1))
              else if (command) setCommand(null)
            }
            // On touch keyboards Enter inserts a newline; the send button sends.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !matchMedia('(pointer: coarse)').matches) {
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
              <button className="send-btn" aria-label="发送" disabled={!canSend} onClick={send}>
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
