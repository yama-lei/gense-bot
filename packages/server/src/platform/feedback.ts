// Global, content-free feedback rows; the user's comments stay in space.sqlite.
import type { SqliteDatabase } from '@earendil-works/chord/sqlite'
import { FEEDBACK_REASONS, type Feedback, type FeedbackSummary } from '@gense/protocol'

export class FeedbackStats {
  readonly db: SqliteDatabase
  constructor(db: SqliteDatabase) { this.db = db }

  static async open(db: SqliteDatabase) {
    await db.run('CREATE TABLE IF NOT EXISTS feedback_stats (userId TEXT NOT NULL, treeId TEXT NOT NULL, turnId TEXT NOT NULL, day TEXT NOT NULL, model TEXT NOT NULL, value TEXT NOT NULL, reasons TEXT NOT NULL, PRIMARY KEY (userId, treeId, turnId))')
    await db.run('CREATE INDEX IF NOT EXISTS feedback_stats_day ON feedback_stats(day, model)')
    return new FeedbackStats(db)
  }

  async set(userId: string, treeId: string, turnId: string, feedback: Feedback | null) {
    if (!feedback) {
      await this.db.run('DELETE FROM feedback_stats WHERE userId = ? AND treeId = ? AND turnId = ?', userId, treeId, turnId)
      return
    }
    await this.db.run('INSERT INTO feedback_stats VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(userId, treeId, turnId) DO UPDATE SET day = excluded.day, model = excluded.model, value = excluded.value, reasons = excluded.reasons', userId, treeId, turnId, new Date(feedback.updatedAt).toISOString().slice(0, 10), feedback.model ?? '', feedback.value, JSON.stringify(feedback.reasons ?? []))
  }

  async summary(from = '1970-01-01', to = new Date().toISOString().slice(0, 10)): Promise<FeedbackSummary[]> {
    for (const day of [from, to]) if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) throw new Error('日期无效')
    if (from > to) throw new Error('日期范围无效')
    const rows = await this.db.all<{ day: string; model: string; value: string; reasons: string }>('SELECT day, model, value, reasons FROM feedback_stats WHERE day >= ? AND day <= ? ORDER BY day DESC, model', from, to)
    const groups = new Map<string, FeedbackSummary>()
    for (const row of rows) {
      const key = JSON.stringify([row.day, row.model])
      const group = groups.get(key) ?? { day: row.day, model: row.model, up: 0, down: 0, reasons: {} }
      if (row.value === 'up') group.up++
      else {
        group.down++
        const reasons = JSON.parse(row.reasons) as string[]
        for (const reason of FEEDBACK_REASONS) if (reasons.includes(reason)) group.reasons[reason] = (group.reasons[reason] ?? 0) + 1
      }
      groups.set(key, group)
    }
    return [...groups.values()]
  }
}
