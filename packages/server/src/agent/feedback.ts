import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { BRIEF_KIND, EVENT_KIND, FEEDBACK_REASONS, type Feedback, type FeedbackReason } from '@gense/protocol'
import { historyEntries } from './history.ts'
import type { UserSpace } from './space.ts'
import type { BranchRow } from './shared.ts'

type Row = { turnId: string; value: 'up' | 'down'; reasons: string; comment: string | null; model: string; updatedAt: number }
const feedbackOf = (row: Row): Feedback => ({ turnId: row.turnId, value: row.value, ...(row.value === 'down' && { reasons: JSON.parse(row.reasons), ...(row.comment !== null && { comment: row.comment }) }), model: row.model, updatedAt: row.updatedAt })

export class FeedbackStore {
  readonly #listeners = new Set<(treeId: string, feedback: Feedback[]) => void>()
  #queue: Promise<unknown> = Promise.resolve()
  readonly space: UserSpace
  constructor(space: UserSpace) { this.space = space }
  subscribe(fn: (treeId: string, feedback: Feedback[]) => void) { this.#listeners.add(fn); return () => { this.#listeners.delete(fn) } }

  async list(treeId: string) {
    await this.space.row(treeId)
    return (await this.space.db.all<Row>('SELECT * FROM feedback WHERE treeId = ? ORDER BY updatedAt, turnId', treeId)).map(feedbackOf)
  }

  async #model(treeId: string, turnId: string) {
    if (!/^\d+$/.test(turnId)) return ''
    const branches = await this.space.db.all<BranchRow>('SELECT * FROM branches WHERE treeId = ? ORDER BY role = \'main\' DESC, createdAt', treeId)
    for (const branch of branches) {
      const entries = await historyEntries(await this.space.open(branch, BACKGROUND_CONTEXT), BACKGROUND_CONTEXT)
      const at = entries.findIndex(entry => String(entry.id) === turnId)
      if (at < 0) continue
      let model = ''
      for (const entry of entries.slice(at + 1)) {
        if (['pi.user', EVENT_KIND, BRIEF_KIND].includes(entry.kind)) break
        if (entry.kind !== 'pi.assistant') continue
        const message = entry.model?.[0]
        if (message?.role === 'assistant') model = `${message.provider}:${message.model}`
      }
      if (model) return model
    }
    return ''
  }

  set(treeId: string, input: { turnId: string; value: 'up' | 'down' | null; reasons?: FeedbackReason[]; comment?: string }) {
    const work = this.#queue.then(async () => {
      const { space } = this
      await space.row(treeId)
      if (typeof input.turnId !== 'string' || !input.turnId || input.turnId.length > 200 || !['up', 'down', null].includes(input.value)) throw new Error('反馈无效')
      if (input.value === 'down' && ((input.reasons !== undefined && (!Array.isArray(input.reasons) || input.reasons.some(r => !FEEDBACK_REASONS.includes(r)))) || (input.comment !== undefined && typeof input.comment !== 'string'))) throw new Error('反馈无效')
      const feedback: Feedback | null = input.value === null ? null : {
        turnId: input.turnId, value: input.value, model: await this.#model(treeId, input.turnId), updatedAt: space.now(),
        ...(input.value === 'down' && { reasons: [...new Set(input.reasons ?? [])], ...(input.comment !== undefined && { comment: input.comment.slice(0, 500) }) }),
      }
      await space.db.transaction(async tx => {
        if (!await tx.get('SELECT id FROM trees WHERE id = ?', treeId)) throw new Error('会话不存在')
        if (!feedback) await tx.run('DELETE FROM feedback WHERE treeId = ? AND turnId = ?', treeId, input.turnId)
        else await tx.run('INSERT INTO feedback (treeId, turnId, value, reasons, comment, model, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(treeId, turnId) DO UPDATE SET value = excluded.value, reasons = excluded.reasons, comment = excluded.comment, model = excluded.model, updatedAt = excluded.updatedAt', treeId, feedback.turnId, feedback.value, JSON.stringify(feedback.reasons ?? []), feedback.comment ?? null, feedback.model!, feedback.updatedAt)
      })
      await space.options.feedback?.(treeId, input.turnId, feedback)
      const all = await this.list(treeId)
      for (const listener of this.#listeners) listener(treeId, all)
    })
    this.#queue = work.catch(() => {})
    return work
  }

  async close() { await this.#queue; this.#listeners.clear() }
}
