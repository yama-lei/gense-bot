import type { SqliteDatabase } from '@earendil-works/chord/sqlite'
import type { OutboxItem } from '../channels/channel.ts'
export class Outbox {
  #db: SqliteDatabase
  #deliver: (item: OutboxItem) => Promise<string>
  #timer?: NodeJS.Timeout
  #draining?: Promise<void>
  #closed = false
  #retryMs: number
  constructor(db: SqliteDatabase, deliver: (item: OutboxItem) => Promise<string>, retryMs = 1000) { this.#db = db; this.#deliver = deliver; this.#retryMs = retryMs }
  start() { this.#timer = setInterval(() => { void this.drain() }, Math.min(500, this.#retryMs)); this.#timer.unref(); void this.drain() }
  drain(): Promise<void> {
    if (this.#closed) return Promise.resolve()
    if (this.#draining) return this.#draining
    const operation = this.#drain().catch(() => {})
    this.#draining = operation
    void operation.finally(() => { if (this.#draining === operation) this.#draining = undefined })
    return operation
  }
  async #drain() {
    const rows = await this.#db.all<{ id: string; data: string; attempts: number }>('SELECT id, data, attempts FROM outbox WHERE delivered_at IS NULL AND next_at <= ? ORDER BY next_at, rowid LIMIT 20', Date.now())
    for (const row of rows) {
      if (this.#closed) return
      try {
        const receipt = await this.#deliver(JSON.parse(row.data))
        await this.#db.run('UPDATE outbox SET receipt = ?, delivered_at = ?, error = NULL WHERE id = ?', receipt, Date.now(), row.id)
      } catch {
        await this.#db.run('UPDATE outbox SET attempts = attempts + 1, next_at = ?, error = ? WHERE id = ?', Date.now() + Math.min(60_000, this.#retryMs * 2 ** Math.min(row.attempts, 10)), 'Delivery failed; retry scheduled', row.id)
      }
    }
  }
  async close() { this.#closed = true; clearInterval(this.#timer); await this.#draining }
}
