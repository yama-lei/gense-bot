import type { PluginDefinition } from './registry.ts'
// One user's plugin switches and settings (roadmap-3 D8), in the host tables next to pi's. Secrets are sealed with
// AES-GCM under the host's TOKEN_ENCRYPTION_KEY and only opened on the host, for the plugin's tools.
import type { SqliteDatabase } from '@earendil-works/chord/sqlite'
import { applySqliteMigrations } from '@earendil-works/chord/sqlite'
import { pluginCatalog, validSetting, type PluginInfo, type PluginValue } from './catalog.ts'

const migrations = [
  {
    version: 1,
    statements: ['CREATE TABLE plugins (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, config TEXT NOT NULL, secrets TEXT)'],
  },
]

export interface PluginStoreOptions {
  /** Plugins this host implements. */
  available: string[]
  /** Settings the host supplies per plugin (`.env`); the customize page only learns which keys exist. */
  defaults?: Record<string, Record<string, string | undefined>>
  /** TOKEN_ENCRYPTION_KEY; without it secrets cannot be saved. */
  secretKey?: string
}

export interface PluginPatch {
  enabled?: boolean
  /** `null` returns a value to its default. */
  values?: Record<string, PluginValue | null>
  /** `null` clears a secret. */
  secrets?: Record<string, string | null>
}

type Row = { id: string; enabled: number; config: string; secrets: string | null }
type Entry = { enabled: boolean; values: Record<string, PluginValue>; secrets: Record<string, string> }

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** AES-GCM with a key derived from the host's secret; sealed text is `base64(iv | ciphertext)`. */
export class Sealer {
  readonly #key: Promise<CryptoKey>

  constructor(secret: string) {
    this.#key = crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(`gense-secrets:${secret}`))
      .then((raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']))
  }

  async seal(text: string) {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.#key, new TextEncoder().encode(text)))
    const out = new Uint8Array(iv.length + sealed.length)
    out.set(iv)
    out.set(sealed, iv.length)
    return b64(out)
  }

  async open(sealed: string) {
    const bytes = unb64(sealed)
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, await this.#key, bytes.subarray(12))
    return new TextDecoder().decode(plain)
  }
}

export class PluginStore {
  readonly #catalog = [...pluginCatalog]
  readonly #db: SqliteDatabase
  readonly #options: PluginStoreOptions
  readonly #sealer: Sealer | undefined
  readonly #entries = new Map<string, Entry>()
  readonly #tools = new Map<string, boolean>()
  readonly #listeners = new Set<() => void>()

  private constructor(db: SqliteDatabase, options: PluginStoreOptions) {
    this.#db = db
    this.#options = options
    this.#sealer = options.secretKey ? new Sealer(options.secretKey) : undefined
  }

  /** Loads every row; secrets that no longer open (a changed key) are dropped. */
  static async open(db: SqliteDatabase, options: PluginStoreOptions) {
    await applySqliteMigrations(db, migrations, { table: 'plugin_migrations' })
    const store = new PluginStore(db, options)
    for (const row of await db.all<Row>('SELECT id, enabled, config, secrets FROM plugins')) {
      let secrets: Record<string, string> = {}
      if (row.secrets && store.#sealer) secrets = JSON.parse(await store.#sealer.open(row.secrets).catch(() => '{}'))
      store.#entries.set(row.id, { enabled: row.enabled === 1, values: JSON.parse(row.config), secrets })
    }
    await db.run('CREATE TABLE IF NOT EXISTS plugin_tools (pluginId TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL, PRIMARY KEY (pluginId, name))')
    for (const row of await db.all<{ pluginId: string; name: string; enabled: number }>('SELECT * FROM plugin_tools')) store.#tools.set(row.pluginId + ':' + row.name, row.enabled === 1)
    return store
  }

  definitions() { return [...this.#catalog] }
  settings(id: string) { return this.#catalog.find(p => p.id === id)?.settings ?? [] }
  resolve(id: string, user: Record<string, PluginValue>, defaults: Record<string, string | undefined>) {
    return Object.fromEntries(this.settings(id).flatMap(s => { const v = user[s.key] ?? defaults[s.key] ?? s.default; return v !== undefined && v !== '' ? [[s.key, v]] : [] }))
  }
  register(definition: PluginDefinition) {
    const at = this.#catalog.findIndex(p => p.id === definition.id)
    if (at < 0) this.#catalog.push(definition)
    else this.#catalog[at] = definition
    if (!this.#options.available.includes(definition.id)) this.#options.available.push(definition.id)
    this.notify()
  }
  async unregister(id: string) {
    const at = this.#catalog.findIndex(p => p.id === id)
    if (at >= 0) this.#catalog.splice(at, 1)
    this.#options.available = this.#options.available.filter(p => p !== id)
    await this.#db.run('DELETE FROM plugins WHERE id = ?', id)
    await this.#db.run('DELETE FROM plugin_tools WHERE pluginId = ?', id)
    this.#entries.delete(id)
    this.notify()
  }
  notify() { for (const l of this.#listeners) l() }

  #entry(id: string): Entry {
    return this.#entries.get(id) ?? { enabled: this.#catalog.find((p) => p.id === id)?.defaultEnabled !== false, values: {}, secrets: {} }
  }

  /** Settings with secrets, as the plugin's tools use them, plus host-only keys the catalog does not declare. Host side only. */
  resolved(id: string): Record<string, PluginValue> {
    const e = this.#entry(id)
    const defaults = this.#options.defaults?.[id] ?? {}
    const declared = new Set(this.settings(id).map((s) => s.key))
    const hostOnly = Object.fromEntries(Object.entries(defaults).filter((kv): kv is [string, string] => !declared.has(kv[0]) && !!kv[1]))
    return { ...hostOnly, ...this.resolve(id, { ...e.values, ...e.secrets }, defaults) }
  }

  /** Enabled, implemented plugins whose settings are complete. Synchronous: the Harness reads it at each resolution. */
  active(): string[] {
    return this.#options.available.filter((id) => this.#entry(id).enabled && !this.#catalog.find(p => p.id === id)!.issue(this.resolved(id)))
  }

  list(): PluginInfo[] {
    return this.#catalog.map((p) => {
      const e = this.#entry(p.id)
      const defaults = this.#options.defaults?.[p.id] ?? {}
      const available = this.#options.available.includes(p.id)
      return {
        id: p.id,
        kind: p.kind ?? 'builtin',
        ...(p.mcp && { mcp: p.mcp() }),
        name: p.name,
        description: p.description,
        sideEffect: p.sideEffect,
        settings: p.settings,
        tools: this.tools(p.id),
        // A plugin on by default is not on where the host lacks it.
        enabled: e.enabled && available,
        available,
        config: { values: e.values, secretsSet: Object.keys(e.secrets), serverKeys: p.settings.filter((s) => defaults[s.key]).map((s) => s.key) },
        issue: p.issue(this.resolved(p.id)),
      }
    })
  }

  tools(id: string) {
    const p = this.#catalog.find(p => p.id === id)
    if (!p) return []
    const tools = p.extension(() => this.resolved(id)).tools ?? []
    const entries = new Map(tools.map(t => [t.name, { name: t.name, description: t.description, enabled: this.toolEnabled(id, t.name), ...(p.resources?.[t.name] && { resourceUri: p.resources[t.name] }), ...(p.viewTools?.[t.name] && { viewOnly: true }) }]))
    for (const [name, t] of Object.entries(p.viewTools ?? {})) entries.set(name, { name, description: t.description, enabled: this.toolEnabled(id, name), viewOnly: true })
    return [...entries.values()]
  }

  toolEnabled(id: string, name: string) { return this.#tools.get(id + ':' + name) ?? true }

  removedTools() { return this.#catalog.flatMap(p => this.tools(p.id).filter(t => !t.enabled || t.viewOnly).map(t => t.name)) }

  async setTool(id: string, name: string, enabled: boolean) {
    if (!this.tools(id).some(t => t.name === name)) throw new Error('未知插件工具')
    await this.#db.run('INSERT INTO plugin_tools VALUES (?, ?, ?) ON CONFLICT (pluginId, name) DO UPDATE SET enabled = excluded.enabled', id, name, enabled ? 1 : 0)
    this.#tools.set(id + ':' + name, enabled)
    for (const l of this.#listeners) l()
  }

  subscribe(listener: () => void) {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  async set(id: string, patch: PluginPatch) {
    if (!this.#catalog.some((p) => p.id === id)) throw new Error('未知插件')
    if (patch.enabled && !this.#options.available.includes(id)) throw new Error('这个部署还没有实现该插件')
    const settings = this.settings(id)
    const current = this.#entry(id)
    const values = { ...current.values }
    for (const [key, v] of Object.entries(patch.values ?? {})) {
      const s = settings.find((x) => x.key === key && x.kind !== 'secret')
      if (!s) throw new Error(`未知设置：${key}`)
      if (v === null) delete values[key]
      else if (validSetting(s, v)) values[key] = v
      else throw new Error(`${s.label} 的值无效`)
    }
    const secrets = { ...current.secrets }
    for (const [key, v] of Object.entries(patch.secrets ?? {})) {
      if (!settings.some((x) => x.key === key && x.kind === 'secret')) throw new Error(`未知密钥：${key}`)
      if (v === null || v === '') delete secrets[key]
      else secrets[key] = v
    }
    const hasSecrets = Object.keys(secrets).length > 0
    if (hasSecrets && !this.#sealer) throw new Error('服务器没有配置 TOKEN_ENCRYPTION_KEY，不能保存密钥')
    const next: Entry = { enabled: patch.enabled ?? current.enabled, values, secrets }
    await this.#db.run(
      'INSERT INTO plugins (id, enabled, config, secrets) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, config = excluded.config, secrets = excluded.secrets',
      id,
      next.enabled ? 1 : 0,
      JSON.stringify(values),
      hasSecrets ? await this.#sealer!.seal(JSON.stringify(secrets)) : null,
    )
    this.#entries.set(id, next)
    for (const l of this.#listeners) l()
  }
}

/**
 * Plugin settings a host takes from its environment: the DeepSeek key for the web plugin, the relay for images.
 * `DEEPSEEK_BASE_URL` is host-only, for a test server.
 */
export const pluginDefaultsFromEnv = (env: Record<string, string | undefined>): Record<string, Record<string, string | undefined>> => ({
  web: { deepseekKey: env.DEEPSEEK_API_KEY || undefined, deepseekUrl: env.DEEPSEEK_BASE_URL || undefined },
  image: { baseUrl: env.PROVIDER_BASE_URL || undefined, apiKey: env.PROVIDER_AUTH_TOKEN || undefined },
})
