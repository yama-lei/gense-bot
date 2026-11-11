// The settings of a plugin or a channel. Secrets are write-only: the page only learns whether one is set.
import { validSetting, type PluginSetting, type PluginSettingsState, type PluginValue } from '@gense/protocol'
import { useState } from 'react'
import { errorText } from '../../lib/format'
import { Button } from '../../ui/button'
import { Notice } from '../../ui/feedback'
import { Input, Textarea } from '../../ui/input'
import { Select } from '../../ui/select'
import { Switch } from '../../ui/switch'

export interface SettingsChange {
  values: Record<string, PluginValue | null>
  secrets: Record<string, string | null>
}

/** `undefined` keeps the stored secret, `null` clears it, a string replaces it. */
type SecretDraft = Record<string, string | null | undefined>

export function SettingsForm({ settings, config, onSave, saveLabel = '保存' }: { settings: PluginSetting[]; config: PluginSettingsState; onSave: (change: SettingsChange) => Promise<unknown>; saveLabel?: string }) {
  const { values, secretsSet, serverKeys } = config
  const [draft, setDraft] = useState<Record<string, PluginValue>>(values)
  const [secrets, setSecrets] = useState<SecretDraft>({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const set = (key: string, v: PluginValue) => {
    setSaved(false)
    setDraft((d) => ({ ...d, [key]: v }))
  }
  const setSecret = (key: string, v: string | null) => {
    setSaved(false)
    setSecrets((x) => ({ ...x, [key]: v }))
  }
  const fromServer = (key: string) => serverKeys.includes(key)

  const save = () => {
    const out: Record<string, PluginValue | null> = {}
    for (const s of settings) {
      if (s.kind === 'secret') continue
      const v = draft[s.key]
      if (v === undefined || v === '') {
        if (values[s.key] !== undefined) out[s.key] = null
        continue
      }
      const value = typeof v === 'string' ? v.trim() : v
      if (!validSetting(s, value)) return setError(`「${s.label}」${s.kind === 'url' ? '需要以 http:// 或 https:// 开头' : '的值无效'}`)
      if (value !== values[s.key]) out[s.key] = value
    }
    const secretOut: Record<string, string | null> = {}
    for (const [key, v] of Object.entries(secrets)) {
      if (v === null) secretOut[key] = null
      else if (v?.trim()) secretOut[key] = v.trim()
    }
    setSaving(true)
    setError(null)
    onSave({ values: out, secrets: secretOut }).then(
      () => {
        setSaving(false)
        setSaved(true)
        setSecrets({})
      },
      (e: unknown) => {
        setSaving(false)
        setError(errorText(e))
      },
    )
  }

  const control = (s: PluginSetting, id: string) => {
    const v = draft[s.key]
    switch (s.kind) {
      case 'toggle':
        return <Switch id={id} checked={typeof v === 'boolean' ? v : s.default === true} onCheckedChange={(on) => set(s.key, on)} />
      case 'select':
        return <Select label={s.label} value={typeof v === 'string' ? v : String(s.default ?? '')} options={s.options ?? []} onChange={(x) => set(s.key, x)} />
      case 'secret': {
        const d = secrets[s.key]
        const isSet = secretsSet.includes(s.key)
        return (
          <div className="flex gap-2">
            <Input
              id={id}
              type="password"
              autoComplete="off"
              value={d ?? ''}
              placeholder={d === null ? '保存后清除' : isSet ? '已设置，输入新值替换' : fromServer(s.key) ? '使用服务器配置' : (s.placeholder ?? '未设置')}
              onChange={(e) => setSecret(s.key, e.target.value)}
            />
            {isSet && d !== null && (
              <Button type="button" className="shrink-0" onClick={() => setSecret(s.key, null)}>
                清除
              </Button>
            )}
          </div>
        )
      }
      case 'textarea':
        return <Textarea id={id} rows={4} value={typeof v === 'string' ? v : ''} placeholder={s.placeholder ?? ''} onChange={(e) => set(s.key, e.target.value)} />
      default:
        return (
          <Input
            id={id}
            type={s.kind === 'url' ? 'url' : 'text'}
            value={typeof v === 'string' ? v : ''}
            placeholder={fromServer(s.key) ? '使用服务器配置' : (s.placeholder ?? (typeof s.default === 'string' ? s.default : ''))}
            onChange={(e) => set(s.key, e.target.value)}
          />
        )
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      {settings.map((s) => {
        const id = `setting-${s.key}`
        const label = (
          <div className="min-w-0">
            <label htmlFor={id} className="text-sm font-medium">
              {s.label}
            </label>
            {s.help && <p className="text-xs text-muted-foreground">{s.help}</p>}
          </div>
        )
        return s.kind === 'toggle' ? (
          <div key={s.key} className="flex items-center justify-between gap-4">
            {label}
            {control(s, id)}
          </div>
        ) : (
          <div key={s.key} className="flex flex-col gap-1.5">
            {label}
            {control(s, id)}
          </div>
        )
      })}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex items-center justify-end gap-3">
        {saved && <span className="text-sm text-success">已保存</span>}
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? '保存中…' : saveLabel}
        </Button>
      </div>
    </form>
  )
}
