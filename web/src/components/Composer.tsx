import { useEffect, useRef, useState, type ReactNode } from 'react'
import { models } from '../mock/seed'
import { findModel, modelKey, modelName } from '../models'
import type { Effort, ModelOption } from '../types'
import { IconArrowUp, IconChevronDown, IconStop } from './Icons'

export const effortLabel: Record<Effort, string> = { low: '低', medium: '中', high: '高' }

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
  onSend: (text: string) => void
  busy?: boolean
  onStop?: () => void
  autoFocus?: boolean
  leftSlot?: ReactNode
  footnote?: boolean
}

export function Composer({ placeholder, model, effort, onModel, onEffort, onSend, busy, onStop, autoFocus, leftSlot, footnote }: Props) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 240) + 'px'
  }, [text])

  const send = () => {
    const value = text.trim()
    if (!value || busy) return
    onSend(value)
    setText('')
  }

  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          autoFocus={autoFocus}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
        />
        <div className="composer-row">
          <div className="composer-left">{leftSlot}</div>
          <div className="composer-right">
            <ModelPicker
              value={model}
              onChange={(key) => {
                onModel(key)
                // Keep effort within what the new model supports (models.dev reasoning levels).
                const efforts = findModel(key)?.capabilities?.efforts ?? []
                if (efforts.length && !efforts.includes(effort)) onEffort(efforts.at(-1)!)
              }}
            />
            {(findModel(model)?.capabilities?.efforts.length ?? 0) > 0 && (
              <Picker
                value={effort}
                options={findModel(model)!.capabilities!.efforts.map((e) => ({ value: e, label: `Effort ${effortLabel[e]}` }))}
                onChange={(v) => onEffort(v as Effort)}
              />
            )}
            {busy ? (
              <button className="send-btn stop" aria-label="停止" onClick={onStop}>
                <IconStop />
              </button>
            ) : (
              <button className="send-btn" aria-label="发送" disabled={!text.trim()} onClick={send}>
                <IconArrowUp />
              </button>
            )}
          </div>
        </div>
      </div>
      {footnote && <p className="footnote">GenseBot 可能出错，请核对重要信息。当前为 Mock，回复由脚本生成。</p>}
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
  const current = findModel(value)
  return (
    <label className="picker strong" title={current ? modelNote(current) : undefined}>
      <span>{modelName(value)}</span>
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
