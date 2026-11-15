import type { SqliteDatabase } from '@earendil-works/chord/sqlite'
import { INBOX_READ_KEPT } from '@gense/protocol'

export class InboxReadStore {
  readonly #db: SqliteDatabase
  readonly #now: () => number
  readonly #listeners = new Set<(ids: string[]) => void>()
  #queue: Promise<unknown> = Promise.resolve()
  constructor(db: SqliteDatabase, now: () => number) { this.#db = db; this.#now = now }
  subscribe(fn: (ids: string[]) => void) { this.#listeners.add(fn); return () => { this.#listeners.delete(fn) } }
  async list() { return (await this.#db.all<{ id: string }>('SELECT id FROM inbox_read ORDER BY readAt DESC, rowid DESC')).map(r => r.id) }
  read(ids: string[]) {
    const operation = this.#queue.then(async () => {
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('已读 id 无效')
      await this.#db.transaction(async tx => {
        const latest = await tx.get<{ at: number | null }>('SELECT MAX(readAt) AS at FROM inbox_read')
        const now = Math.max(this.#now(), (latest?.at ?? 0) + 1)
        for (const id of [...new Set(ids.slice(0, INBOX_READ_KEPT).map(id => id.slice(0, 200)))])
          await tx.run('INSERT INTO inbox_read (id, readAt) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET readAt = excluded.readAt', id, now)
        await tx.run('DELETE FROM inbox_read WHERE id NOT IN (SELECT id FROM inbox_read ORDER BY readAt DESC, rowid DESC LIMIT ?)', INBOX_READ_KEPT)
      })
      const all = await this.list()
      for (const listener of this.#listeners) listener(all)
    })
    this.#queue = operation.catch(() => {})
    return operation
  }
  async close() { await this.#queue; this.#listeners.clear() }
}
