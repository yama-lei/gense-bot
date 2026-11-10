import type { SqliteDatabase } from '@earendil-works/chord/sqlite'
import type { TriggerDecision, TriggerInfo } from '@gense/protocol'
import type { InboundTrigger, OutboxItem } from '../channels/channel.ts'
export interface StoredTrigger { id: string; source: string; thread_key: string; actor: string; payload: string; decision: TriggerDecision; tree_id: string | null; created_at: number; delivered_at: number | null; result: string | null }
export class TriggerStore {
  readonly db: SqliteDatabase
  private constructor(db: SqliteDatabase) { this.db = db }
  static async open(db: SqliteDatabase) {
    await db.run('CREATE TABLE IF NOT EXISTS triggers (id TEXT PRIMARY KEY, source TEXT NOT NULL, thread_key TEXT NOT NULL, actor TEXT NOT NULL, payload TEXT NOT NULL, decision TEXT NOT NULL, tree_id TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER, result TEXT)')
    await db.run('CREATE INDEX IF NOT EXISTS triggers_source ON triggers (source, created_at)')
    await db.run('CREATE TABLE IF NOT EXISTS threads (source TEXT NOT NULL, thread_key TEXT NOT NULL, tree_id TEXT NOT NULL, PRIMARY KEY (source, thread_key))')
    await db.run('CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, trigger_id TEXT NOT NULL, data TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, receipt TEXT, delivered_at INTEGER, error TEXT)')
    return new TriggerStore(db)
  }
  get(id: string) { return this.db.get<StoredTrigger>('SELECT * FROM triggers WHERE id = ?', id) }
  async admit(trigger: InboundTrigger, allowed: boolean, extra: Record<string, unknown> = {}, decision: TriggerDecision = 'accepted') {
    return this.db.transaction(async tx => {
      const existing = await tx.get<StoredTrigger>('SELECT * FROM triggers WHERE id = ?', trigger.id)
      if (existing) return { row: existing, duplicate: true }
      const createdAt = trigger.createdAt ?? Date.now()
      const payload = JSON.stringify({ ...trigger, ...extra, ...(!allowed && { reason: extra.reason ?? '身份不在此来源的允许名单中' }) })
      await tx.run('INSERT INTO triggers (id, source, thread_key, actor, payload, decision, tree_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', trigger.id, trigger.source, trigger.thread.key, JSON.stringify(trigger.actor), payload, allowed ? decision : 'rejected', trigger.treeId ?? null, createdAt)
      return { row: (await tx.get<StoredTrigger>('SELECT * FROM triggers WHERE id = ?', trigger.id))!, duplicate: false }
    })
  }
  async list(source: string, limit = 50): Promise<TriggerInfo[]> {
    const rows = await this.db.all<StoredTrigger>('SELECT * FROM triggers WHERE source = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', source, Math.min(200, Math.max(1, Number.isFinite(limit) ? limit : 50)))
    return rows.map(r => { const p = JSON.parse(r.payload) as InboundTrigger & { reason?: string }; return { id: r.id, source: r.source, thread: p.thread, actor: JSON.parse(r.actor), text: p.text, decision: r.decision, ...(p.reason && { reason: p.reason }), ...(r.tree_id && { treeId: r.tree_id }), createdAt: r.created_at } })
  }
  async bind(id: string, treeId: string) { await this.db.run('UPDATE triggers SET tree_id = ? WHERE id = ?', treeId, id) }
  async delivered(id: string, result?: unknown) { await this.db.run('UPDATE triggers SET delivered_at = ?, result = COALESCE(?, result) WHERE id = ?', Date.now(), result === undefined ? null : JSON.stringify(result), id) }
  async thread(source: string, key: string) { return (await this.db.get<{ tree_id: string }>('SELECT tree_id FROM threads WHERE source = ? AND thread_key = ?', source, key))?.tree_id }
  async setThread(source: string, key: string, treeId: string) { await this.db.run('INSERT INTO threads VALUES (?, ?, ?) ON CONFLICT (source, thread_key) DO UPDATE SET tree_id = excluded.tree_id', source, key, treeId) }
  /** Final run outcome and every final delivery enter one SQLite transaction. */
  async complete(id: string, result: unknown, items: OutboxItem[]) {
    await this.db.transaction(async tx => {
      await tx.run('UPDATE triggers SET result = ?, delivered_at = COALESCE(delivered_at, ?) WHERE id = ?', JSON.stringify(result), Date.now(), id)
      for (const item of items) await tx.run('INSERT INTO outbox (id, channel_id, trigger_id, data, next_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING', item.id, item.channelId, item.triggerId, JSON.stringify(item), Date.now())
    })
  }
}
