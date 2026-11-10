import type { SqliteDatabase } from '@earendil-works/chord/sqlite'
import type { Preferences } from '@gense/protocol'

export class PreferenceStore {
  #value: Preferences = { name: '', instructions: '' }
  #listeners = new Set<() => void>()
  private db: SqliteDatabase
  private constructor(db: SqliteDatabase) { this.db = db }
  static async open(db: SqliteDatabase) {
    await db.run('CREATE TABLE IF NOT EXISTS preferences (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)')
    const store = new PreferenceStore(db)
    const row = await db.get<{ value: string }>('SELECT value FROM preferences WHERE id = 1')
    if (row) store.#value = JSON.parse(row.value)
    return store
  }
  get(): Preferences { return { ...this.#value } }
  subscribe(listener: () => void) { this.#listeners.add(listener); return () => { this.#listeners.delete(listener) } }
  async set(patch: Partial<Preferences>) {
    const next = { ...this.#value }
    for (const key of ['name', 'instructions'] as const) {
      if (patch[key] === undefined) continue
      if (typeof patch[key] !== 'string' || patch[key].length > (key === 'name' ? 200 : 20_000)) throw new Error('偏好无效')
      next[key] = patch[key]
    }
    await this.db.run('INSERT INTO preferences VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET value = excluded.value', JSON.stringify(next))
    this.#value = next
    for (const l of this.#listeners) l()
    return this.get()
  }
  prompt() {
    return [this.#value.name && `称呼用户：${this.#value.name}`, this.#value.instructions].filter(Boolean).join('\n') || undefined
  }
}
