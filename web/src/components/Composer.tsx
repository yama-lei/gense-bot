import { useEffect, useRef, useState, type ReactNode } from 'react'
import { models } from '../mock/seed'
import type { Effort } from '../types'
import { IconArrowUp, IconChevronDown, IconStop } from './Icons'

export const effortLabel: Record<Effort, string> = { low: '低', medium: '中', high: '高' }

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
            <Picker value={model} options={models.map((m) => ({ value: m, label: m.replace('Workers AI · ', '') }))} onChange={onModel} strong />
            <Picker value={effort} options={(['low', 'medium', 'high'] as Effort[]).map((e) => ({ value: e, label: `Effort ${effortLabel[e]}` }))} onChange={(v) => onEffort(v as Effort)} />
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
