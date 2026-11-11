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
    for (const key of ['name', 'instructions', 'timeZone'] as const) {
      if (patch[key] === undefined) continue
      if (typeof patch[key] !== 'string' || patch[key].length > (key === 'instructions' ? 20_000 : 200)) throw new Error('偏好无效')
      if (key === 'timeZone' && !validTimeZone(patch[key])) throw new Error('时区无效')
      next[key] = patch[key]
    }
    await this.db.run('INSERT INTO preferences VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET value = excluded.value', JSON.stringify(next))
    this.#value = next
    for (const l of this.#listeners) l()
    return this.get()
  }
  /** The user's own words about how to answer; the time zone goes into the assistant section instead. */
  prompt() {
    const { name, instructions } = this.#value
    if (!name && !instructions) return undefined
    return [
      name && `The user's name is ${name}; address them by it when it fits.`,
      instructions && `The user's instructions for how you should work. Where they differ from your default guidance, follow them:\n<user_instructions>\n${instructions}\n</user_instructions>`,
    ].filter(Boolean).join('\n')
  }
}

function validTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz })
    return true
  } catch {
    return false
  }
}
