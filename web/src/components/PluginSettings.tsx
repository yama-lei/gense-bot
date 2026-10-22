import { useState } from 'react'
import { validSetting } from '../plugins/catalog'
import type { Store } from '../store'
import type { PluginInfo, PluginSetting, PluginValue } from '../types'

// Settings form of one plugin on the customize page (docs/plans/roadmap-2.md "L0-5 插件配置").
// Secrets are write-only: the page only learns whether one is set.

/** `undefined` keeps the stored secret, `null` clears it, a string replaces it. */
type SecretDraft = Record<string, string | null | undefined>

export function PluginSettings({ plugin, store, onClose }: { plugin: PluginInfo; store: Store; onClose: () => void }) {
  const { values, secretsSet, serverKeys } = plugin.config
  const [draft, setDraft] = useState<Record<string, PluginValue>>(values)
  const [secrets, setSecrets] = useState<SecretDraft>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const models = store.state.models.filter((m) => m.provider === 'openai')

  const set = (key: string, v: PluginValue) => setDraft((d) => ({ ...d, [key]: v }))
  const fromServer = (key: string) => serverKeys.includes(key)

  const save = async () => {
    const out: Record<string, PluginValue | null> = {}
    for (const s of plugin.settings) {
      if (s.kind === 'secret') continue
      const v = draft[s.key]
      if (v === undefined || v === '') {
        if (values[s.key] !== undefined) out[s.key] = null
        continue
      }
      const value = typeof v === 'string' ? v.trim() : v
      if (!validSetting(s, value)) return setError(`「${s.label}」${s.kind === 'url' ? '需要以 https:// 开头' : '的值无效'}`)
      out[s.key] = value
    }
    const secretOut = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v === null || (v !== undefined && v.trim())) as [string, string | null][])
    setSaving(true)
    setError(null)
    try {
      await store.setPluginConfig(plugin.id, out, secretOut)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const control = (s: PluginSetting) => {
    const v = draft[s.key]
    switch (s.kind) {
      case 'toggle': {
        const on = typeof v === 'boolean' ? v : s.default === true
        return (
          <button type="button" role="switch" aria-checked={on} aria-label={s.label} className={'toggle' + (on ? ' on' : '')} onClick={() => set(s.key, !on)}>
            <span />
          </button>
        )
      }
      case 'select':
        return (
          <select value={typeof v === 'string' ? v : String(s.default ?? '')} onChange={(e) => set(s.key, e.target.value)}>
            {s.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )
      case 'model':
        return (
          <select value={typeof v === 'string' ? v : ''} onChange={(e) => set(s.key, e.target.value)}>
            <option value="">{fromServer(s.key) ? '使用服务器默认模型' : '不使用'}</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
            {typeof v === 'string' && v && !models.some((m) => m.id === v) && <option value={v}>{v}</option>}
          </select>
        )
      case 'secret': {
        const d = secrets[s.key]
        const placeholder = d === null ? '保存后清除' : secretsSet.includes(s.key) ? '已设置，输入新值替换' : fromServer(s.key) ? '使用服务器配置' : '未设置'
        return (
          <span className="setting-secret">
            <input type="password" autoComplete="off" value={d ?? ''} placeholder={placeholder} onChange={(e) => setSecrets((x) => ({ ...x, [s.key]: e.target.value }))} />
            {secretsSet.includes(s.key) && d !== null && (
              <button type="button" className="pill-btn small" onClick={() => setSecrets((x) => ({ ...x, [s.key]: null }))}>
                清除
              </button>
            )}
          </span>
        )
      }
      default:
        return (
          <input
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
      className="plugin-settings"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      {plugin.settings.map((s) => (
        <label key={s.key} className={'setting' + (s.kind === 'toggle' ? ' inline' : '')}>
          <span className="setting-label">
            {s.label}
            {s.help && <small className="muted">{s.help}</small>}
          </span>
          {control(s)}
        </label>
      ))}
      {error && <p className="small error-text">{error}</p>}
      <div className="setting-actions">
        <button type="button" className="btn" onClick={onClose}>
          取消
        </button>
        <button type="submit" className="btn primary" disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </form>
  )
}
