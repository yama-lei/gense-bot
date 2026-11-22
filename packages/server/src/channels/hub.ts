import type { SqliteDatabase } from '@earendil-works/chord/sqlite'
import type { ChannelActor, ChannelInfo, PluginValue } from '@gense/protocol'
import { validSetting } from '@gense/protocol'
import { createHash, randomBytes } from 'node:crypto'
import { Sealer, type PluginPatch } from '../plugins/store.ts'
import type { Channel, ChannelDefinition, InboundTrigger, OutboxItem } from './channel.ts'

type Config = { enabled: boolean; values: Record<string, PluginValue>; secrets: Record<string, string> }
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
export class ChannelHub {
  #db: SqliteDatabase
  #sealer?: Sealer
  #definitions = new Map<string, ChannelDefinition>()
  #configs = new Map<string, Config>()
  #actors = new Map<string, ChannelActor[]>()
  #states = new Map<string, Partial<ChannelInfo>>()
  #channels = new Map<string, Channel>()
  #listeners = new Set<() => void>()
  #pairAttempts = new Map<string, { count: number; since: number }>()
  #ingest?: (trigger: InboundTrigger) => Promise<unknown>
  #closed = false
  private constructor(db: SqliteDatabase, key?: string) { this.#db = db; this.#sealer = key ? new Sealer(key) : undefined }
  static async open(db: SqliteDatabase, key?: string) {
    await db.run('CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, values_json TEXT NOT NULL, secrets TEXT NOT NULL)')
    await db.run('CREATE TABLE IF NOT EXISTS channel_actors (channel_id TEXT NOT NULL, actor_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (channel_id, actor_id))')
    await db.run('CREATE TABLE IF NOT EXISTS channel_pairs (code_hash TEXT PRIMARY KEY, channel_id TEXT NOT NULL, expires_at INTEGER NOT NULL)')
    const hub = new ChannelHub(db, key)
    for (const row of await db.all<{ id: string; enabled: number; values_json: string; secrets: string }>('SELECT * FROM channels')) {
      const secrets = row.secrets && hub.#sealer ? JSON.parse(await hub.#sealer.open(row.secrets).catch(() => '{}')) : {}
      hub.#configs.set(row.id, { enabled: row.enabled === 1, values: JSON.parse(row.values_json), secrets })
    }
    for (const row of await db.all<{ channel_id: string; data: string }>('SELECT * FROM channel_actors')) hub.#actors.set(row.channel_id, [...(hub.#actors.get(row.channel_id) ?? []), JSON.parse(row.data)])
    return hub
  }
  register(definition: ChannelDefinition) { this.#definitions.set(definition.id, definition); this.#notify() }
  #definition(id: string) { const def = this.#definitions.get(id); if (!def) throw new Error('未知渠道'); return def }
  #config(id: string): Config { return this.#configs.get(id) ?? { enabled: false, values: {}, secrets: {} } }
  resolved(id: string): Record<string, PluginValue> {
    const c = this.#config(id)
    return Object.fromEntries(this.#definition(id).settings.flatMap(s => { const v = c.secrets[s.key] ?? c.values[s.key] ?? s.default; return v !== undefined ? [[s.key, v]] : [] }))
  }
  list(): ChannelInfo[] {
    return [...this.#definitions.values()].map(d => { const c = this.#config(d.id); return { id: d.id, name: d.name, description: d.description, settings: d.settings, enabled: c.enabled, status: 'off', ...this.#states.get(d.id), config: { values: { ...c.values }, secretsSet: Object.keys(c.secrets), serverKeys: [] }, actors: [...(this.#actors.get(d.id) ?? [])] } })
  }
  subscribe(listener: () => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener) } }
  #notify() { for (const l of this.#listeners) l() }
  isAllowed(source: string, actorId: string) { return this.#definitions.has(source) ? !!this.#actors.get(source)?.some(a => a.id === actorId) : ['web', 'schedule', 'webhook', 'agent', 'system'].includes(source) && actorId === 'owner' }
  async set(id: string, patch: PluginPatch) {
    const d = this.#definition(id), current = this.#config(id)
    const next: Config = { enabled: patch.enabled ?? current.enabled, values: { ...current.values }, secrets: { ...current.secrets } }
    for (const [key, value] of Object.entries(patch.values ?? {})) {
      const setting = d.settings.find(s => s.key === key && s.kind !== 'secret')
      if (!setting || (value !== null && !validSetting(setting, value))) throw new Error('渠道设置无效：' + key)
      if (value === null) delete next.values[key]; else next.values[key] = value
    }
    for (const [key, value] of Object.entries(patch.secrets ?? {})) {
      const setting = d.settings.find(s => s.key === key && s.kind === 'secret')
      if (!setting || (value !== null && !validSetting(setting, value))) throw new Error('渠道密钥无效：' + key)
      if (value === null || value === '') delete next.secrets[key]; else next.secrets[key] = value
    }
    if (Object.keys(next.secrets).length && !this.#sealer) throw new Error('需要 TOKEN_ENCRYPTION_KEY 保存渠道密钥')
    await this.#db.run('INSERT INTO channels VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, values_json = excluded.values_json, secrets = excluded.secrets', id, next.enabled ? 1 : 0, JSON.stringify(next.values), Object.keys(next.secrets).length ? await this.#sealer!.seal(JSON.stringify(next.secrets)) : '')
    this.#configs.set(id, next)
    if (this.#ingest) await this.#restart(id)
    this.#notify()
  }
  async start(ingest: (trigger: InboundTrigger) => Promise<unknown>) {
    this.#ingest = ingest
    for (const id of this.#definitions.keys()) await this.#restart(id)
  }
  async #restart(id: string) {
    await this.#channels.get(id)?.stop(); this.#channels.delete(id)
    this.#states.set(id, { status: this.#config(id).enabled ? 'connecting' : 'off' }); this.#notify()
    if (!this.#config(id).enabled || this.#closed) return
    const update = (patch: Partial<ChannelInfo>) => { if (!this.#closed && this.#config(id).enabled) { this.#states.set(id, { ...this.#states.get(id), ...patch }); this.#notify() } }
    const channel = this.#definition(id).create(this.resolved(id), update)
    this.#channels.set(id, channel)
    try { await channel.start(this.#ingest!); if (this.#states.get(id)?.status === 'connecting') update({ status: 'ready' }) }
    catch (error) { update({ status: 'error', error: error instanceof Error ? error.message : '渠道连接失败，请检查凭据和网络' }) }
  }
  async deliver(item: OutboxItem) { const channel = this.#channels.get(item.channelId); if (!channel || !this.#config(item.channelId).enabled) throw new Error('渠道未连接'); return channel.deliver(item) }
  async render(channelId: string, triggerId: string, treeId: string, text: string) { await this.#channels.get(channelId)?.render?.(triggerId, treeId, text) }
  async pair(id: string) {
    this.#definition(id)
    const code = randomBytes(4).toString('hex').toUpperCase(), expiresAt = Date.now() + 10 * 60_000
    await this.#db.transaction(async tx => { await tx.run('DELETE FROM channel_pairs WHERE channel_id = ? OR expires_at < ?', id, Date.now()); await tx.run('INSERT INTO channel_pairs VALUES (?, ?, ?)', hash(code), id, expiresAt) })
    return { code, expiresAt }
  }
  async consumePair(id: string, code: string, actor: { id: string; name: string }, trigger?: InboundTrigger) {
    this.#definition(id)
    const key = id + ':' + actor.id, now = Date.now(), prior = this.#pairAttempts.get(key)
    const attempts = prior && now - prior.since < 60_000 ? prior : { count: 0, since: now }
    if (++attempts.count > 20) return false
    this.#pairAttempts.set(key, attempts)
    const paired = await this.#db.transaction(async tx => {
      const row = await tx.get<{ channel_id: string; expires_at: number }>('SELECT * FROM channel_pairs WHERE code_hash = ?', hash(code.trim().toUpperCase()))
      if (!row || row.channel_id !== id || row.expires_at <= now) return false
      const owner: ChannelActor = { ...actor, role: 'owner', addedAt: now }
      await tx.run('DELETE FROM channel_pairs WHERE channel_id = ?', id)
      for (const a of this.#actors.get(id) ?? []) if (a.role === 'owner') await tx.run('DELETE FROM channel_actors WHERE channel_id = ? AND actor_id = ?', id, a.id)
      await tx.run('INSERT INTO channel_actors VALUES (?, ?, ?) ON CONFLICT (channel_id, actor_id) DO UPDATE SET data = excluded.data', id, actor.id, JSON.stringify(owner))
      if (trigger) await tx.run("INSERT INTO triggers (id, source, thread_key, actor, payload, decision, created_at) VALUES (?, ?, ?, ?, ?, 'command', ?) ON CONFLICT (id) DO NOTHING", trigger.id, trigger.source, trigger.thread.key, JSON.stringify(trigger.actor), JSON.stringify({ ...trigger, command: 'pair' }), now)
      return owner
    })
    if (!paired) return false
    this.#actors.set(id, [...(this.#actors.get(id) ?? []).filter(a => a.role !== 'owner' && a.id !== actor.id), paired]); this.#notify()
    return true
  }
  async allow(id: string, actorId: string, name: string) {
    this.#definition(id)
    if (!actorId.trim() || actorId.length > 200 || name.length > 200) throw new Error('身份无效')
    const current = this.#actors.get(id)?.find(a => a.id === actorId)
    const actor: ChannelActor = { id: actorId, name, role: current?.role ?? 'allowed', addedAt: current?.addedAt ?? Date.now() }
    await this.#db.run('INSERT INTO channel_actors VALUES (?, ?, ?) ON CONFLICT (channel_id, actor_id) DO UPDATE SET data = excluded.data', id, actorId, JSON.stringify(actor))
    this.#actors.set(id, [...(this.#actors.get(id) ?? []).filter(a => a.id !== actorId), actor]); this.#notify()
  }
  async revoke(id: string, actorId: string) { this.#definition(id); await this.#db.run('DELETE FROM channel_actors WHERE channel_id = ? AND actor_id = ?', id, actorId); this.#actors.set(id, (this.#actors.get(id) ?? []).filter(a => a.id !== actorId)); this.#notify() }
  async close() { this.#closed = true; for (const channel of this.#channels.values()) await channel.stop(); this.#listeners.clear() }
}
