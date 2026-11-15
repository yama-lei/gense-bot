// Host-wide provider configuration and usage. Only public metadata leaves this module.
import { applySqliteMigrations, type SqliteDatabase } from '@earendil-works/chord/sqlite'
import { createAssistantMessageEventStream, type AssistantMessage, type MutableModels } from '@earendil-works/pi-ai'
import { DEEPSEEK_BASE_URL, type ModelSource, type SharedProviderInfo, type SharedProviderInput, type UsageSummary } from '@gense/protocol'
import { relayModels, type ModelSetup } from '../agent/models.ts'
import { deepseekModels, DEEPSEEK_MODELS } from '../agent/deepseek.ts'
import { Sealer } from '../plugins/store.ts'
import type { DeepSeekService } from '../agent/deepseek-services.ts'
import { initializeServiceUsage, recordServiceUsage } from './service-usage.ts'

const migrations = [{ version: 1, statements: [
  'CREATE TABLE shared_providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, baseUrl TEXT NOT NULL, modelIds TEXT NOT NULL, sealed TEXT NOT NULL)',
  'CREATE TABLE usage (id INTEGER PRIMARY KEY, userId TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, source TEXT NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cacheRead INTEGER NOT NULL, cacheWrite INTEGER NOT NULL, totalTokens INTEGER NOT NULL, createdAt INTEGER NOT NULL)',
  'CREATE INDEX usage_user_day ON usage(userId, createdAt)',
] }, { version: 2, statements: ["ALTER TABLE shared_providers ADD COLUMN kind TEXT NOT NULL DEFAULT 'openai'"] }]
type ProviderRow = { id: string; kind: 'openai' | 'deepseek'; name: string; baseUrl: string; modelIds: string; sealed: string }
const publicProvider = (r: ProviderRow): SharedProviderInfo => ({ id: r.id, kind: r.kind, name: r.name, baseUrl: r.baseUrl, modelIds: JSON.parse(r.modelIds), hasKey: !!r.sealed })

export class AppStore {
  readonly #db: SqliteDatabase
  readonly #sealer?: Sealer
  #models: ModelSetup = { providers: [], options: [], defaultModel: null }
  readonly #listeners = new Set<() => Promise<void>>()
  #mutating: Promise<unknown> = Promise.resolve()
  readonly #pending = new Set<Promise<unknown>>()
  private constructor(db: SqliteDatabase, key?: string) { this.#db = db; this.#sealer = key ? new Sealer(key) : undefined }
  static async open(db: SqliteDatabase, key?: string) {
    await applySqliteMigrations(db, migrations, { table: 'host_migrations' })
    await initializeServiceUsage(db)
    const store = new AppStore(db, key)
    await store.#reload()
    return store
  }
  models = () => this.#models
  /** Standalone OCR/speech use a shared provider, never a user's ambient credentials. */
  async deepseekService(): Promise<DeepSeekService | undefined> {
    if (!this.#sealer) return undefined
    const row = await this.#db.get<ProviderRow>("SELECT * FROM shared_providers WHERE kind = 'deepseek' AND sealed != '' ORDER BY id LIMIT 1")
    return row ? { provider: row.id, baseUrl: row.baseUrl, key: await this.#sealer.open(row.sealed) } : undefined
  }
  recordService(userId: string, service: import('@gense/protocol').ServiceKind, units: number) { return recordServiceUsage(this.#db, userId, service, units) }
  subscribe(fn: () => Promise<void>) { this.#listeners.add(fn); return () => { this.#listeners.delete(fn) } }
  async providers() { return (await this.#db.all<ProviderRow>('SELECT * FROM shared_providers ORDER BY id')).map(publicProvider) }
  async #reload() {
    const setups: ModelSetup[] = []
    for (const row of await this.#db.all<ProviderRow>('SELECT * FROM shared_providers ORDER BY id')) {
      if (!this.#sealer) throw new Error('共享模型需要 TOKEN_ENCRYPTION_KEY')
      setups.push((row.kind === 'deepseek' ? deepseekModels : relayModels)({ providerId: row.id, name: row.name, baseUrl: row.baseUrl, apiKey: await this.#sealer.open(row.sealed), modelIds: JSON.parse(row.modelIds) }))
    }
    const options = setups.flatMap(s => s.options)
    this.#models = { providers: setups.flatMap(s => s.providers), options, defaultModel: options[0] ?? null, kinds: Object.assign({}, ...setups.map(s => s.kinds)) }
    await Promise.all([...this.#listeners].map(fn => fn()))
  }
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#mutating.then(fn, fn)
    this.#mutating = next.catch(() => {})
    return next
  }
  async putProvider(input: SharedProviderInput, id = `shared-${crypto.randomUUID()}`) {
    return this.#serial(async () => {
      if (!this.#sealer) throw new Error('共享模型需要 TOKEN_ENCRYPTION_KEY')
      const old = await this.#db.get<ProviderRow>('SELECT * FROM shared_providers WHERE id = ?', id)
      if (input.kind !== 'openai' && input.kind !== 'deepseek') throw new Error('提供方类型无效')
      const modelIds = input.kind === 'deepseek' && Array.isArray(input.modelIds) && !input.modelIds.length ? DEEPSEEK_MODELS : input.modelIds
      const url = new URL(input.baseUrl || (input.kind === 'deepseek' ? DEEPSEEK_BASE_URL : ''))
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('模型地址无效')
      if (!input.name?.trim() || input.name.length > 200 || !Array.isArray(modelIds) || !modelIds.length || modelIds.length > 200 || modelIds.some(m => typeof m !== 'string' || !m.trim() || m.length > 300)) throw new Error('名称或模型列表无效')
      if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || !input.apiKey.trim())) throw new Error('密钥不能为空')
      const sealed = input.apiKey ? await this.#sealer.seal(input.apiKey) : old?.sealed
      if (!sealed) throw new Error('需要密钥')
      await this.#db.run('INSERT INTO shared_providers (id, name, baseUrl, modelIds, sealed, kind) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, baseUrl = excluded.baseUrl, modelIds = excluded.modelIds, sealed = excluded.sealed, kind = excluded.kind', id, input.name.trim(), url.href, JSON.stringify([...new Set(modelIds.map(m => m.trim()))]), sealed, input.kind)
      await this.#reload()
      return (await this.providers()).find(p => p.id === id)!
    })
  }
  async deleteProvider(id: string) {
    return this.#serial(async () => {
      await this.#db.run('DELETE FROM shared_providers WHERE id = ?', id)
      await this.#reload()
    })
  }
  async record(userId: string, message: AssistantMessage, source: ModelSource) {
    if (message.stopReason === 'pending' || message.stopReason === 'deferred') return
    const u = message.usage
    await this.#db.run('INSERT INTO usage (userId, provider, model, source, input, output, cacheRead, cacheWrite, totalTokens, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', userId, message.provider, message.model, source, u.input, u.output, u.cacheRead, u.cacheWrite, u.totalTokens, Date.now())
  }
  /** Intercept streams, including compaction and error responses. complete* delegates to these methods. */
  meter(userId: string, models: MutableModels, source: (provider: string) => ModelSource) {
    for (const key of ['stream', 'streamSimple', 'streamDeferred'] as const) {
      const original = models[key].bind(models) as (...args: any[]) => ReturnType<MutableModels['streamSimple']>
      const wrapped = (...args: any[]) => {
        const upstream = original(...args), stream = createAssistantMessageEventStream()
        const model = args[0]
        const label = source(model.provider)
        const done = (async () => {
          let recorded = false
          for await (const event of upstream) {
            if (event.type === 'done' || event.type === 'error') {
              const message = event.type === 'done' ? event.message : event.error
              await this.record(userId, message, label)
              recorded = true
            }
            stream.push(event)
          }
          const message = await upstream.result()
          if (!recorded) await this.record(userId, message, label)
          stream.end(message)
        })()
        this.#pending.add(done)
        void done.catch(error => stream.end({ api: model.api, provider: model.provider, model: model.id, role: 'assistant', content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'error', errorMessage: String(error), timestamp: Date.now() })).finally(() => this.#pending.delete(done))
        return stream
      }
      Object.defineProperty(models, key, { value: wrapped, writable: true, configurable: true })
    }
  }
  async flush() { await this.#mutating; await Promise.all([...this.#pending]) }
  async usage(from?: string, to?: string): Promise<UsageSummary[]> {
    const day = (v: string | undefined) => {
      if (v === undefined) return undefined
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || new Date(v).toISOString().slice(0, 10) !== v) throw new Error('日期无效')
      return Date.parse(v)
    }
    const start = day(from) ?? 0, end = (day(to) ?? Date.now()) + 86400_000
    return this.#db.all<UsageSummary>(`SELECT u.userId, a.email, strftime('%Y-%m-%d', u.createdAt / 1000, 'unixepoch') AS day, u.provider, u.model, u.source, COUNT(*) AS calls, SUM(u.input) AS input, SUM(u.output) AS output, SUM(u.cacheRead) AS cacheRead, SUM(u.cacheWrite) AS cacheWrite, SUM(u.totalTokens) AS totalTokens FROM usage u JOIN users a ON a.id = u.userId WHERE u.createdAt >= ? AND u.createdAt < ? GROUP BY u.userId, day, u.provider, u.model, u.source ORDER BY day DESC, a.email`, start, end)
  }
}
