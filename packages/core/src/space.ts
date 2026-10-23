// One user's conversations: a pi-durable Harness plus the sidebar index, in the same SQLite database (roadmap-3 D2).
// In stage 1 a tree is a single ownerless conversation, its root; tree ids are ours, conversation ids are pi-durable's.
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import { applySqliteMigrations, type SqliteDatabase } from '@earendil-works/chord/sqlite'
import type { Models } from '@earendil-works/pi-ai'
import { createRegistry, defineExtension, Harness, section, type ConversationId, type HarnessOptions } from '@earendil-works/pi-durable'
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite'
import { RUN_ERROR_KIND, type Effort, type ModelInfo, type RunErrorData, type TreeMeta } from './protocol.ts'

const DEFAULT_TITLE = '新对话'
const TITLE_CHARS = 30

const migrations = [
  {
    version: 1,
    statements: [
      'CREATE TABLE trees (id TEXT PRIMARY KEY, rootId INTEGER NOT NULL, title TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)',
    ],
  },
]

const PREAMBLE = [
  '你是 gense，用户的个人助理。',
  '用用户使用的语言回答，简洁、准确；不确定时直接说明。',
].join('\n')

const gense = defineExtension({ name: 'gense', sections: [section('assistant', () => PREAMBLE)] })

export interface SpaceOptions {
  models: Models
  defaultModel: ModelInfo | null
  /** Passed through to the Harness: wake scheduling and settings belong to the host. */
  harness?: Pick<HarnessOptions, 'onWake' | 'setTimer' | 'now' | 'settings' | 'onReport'>
  now?: () => number
}

type TreeRow = { id: string; rootId: number; title: string; pinned: number; createdAt: number; updatedAt: number }
const COLUMNS = 'id, rootId, title, pinned, createdAt, updatedAt'
const toMeta = ({ rootId: _, ...r }: TreeRow): TreeMeta => ({ ...r, pinned: r.pinned === 1 })

export class UserSpace {
  private readonly listeners = new Set<(trees: TreeMeta[]) => void>()
  private readonly db: SqliteDatabase
  readonly harness: Harness
  private readonly options: SpaceOptions

  private constructor(db: SqliteDatabase, harness: Harness, options: SpaceOptions) {
    this.db = db
    this.harness = harness
    this.options = options
  }

  /** Opens the database's host tables and pi-durable storage. The Harness owns `db` and closes it in `close()`. */
  static async open(db: SqliteDatabase, options: SpaceOptions, ctx: Context = BACKGROUND_CONTEXT) {
    await applySqliteMigrations(db, migrations, { table: 'app_migrations' })
    const storage = await SqliteStorage.open(db, { prefix: 'pi_' })
    const registry = createRegistry()
    registry.install(gense)
    const harness = await Harness.open(storage, { ...options.harness, models: options.models, registry }, ctx)
    // Continue runs a previous process left unfinished (R32).
    harness.resume()
    return new UserSpace(db, harness, options)
  }

  private now() {
    return (this.options.now ?? Date.now)()
  }

  async trees(): Promise<TreeMeta[]> {
    const rows = await this.db.all<TreeRow>(`SELECT ${COLUMNS} FROM trees ORDER BY pinned DESC, updatedAt DESC`)
    return rows.map(toMeta)
  }

  /** Called with the full list after every change. */
  subscribeTrees(listener: (trees: TreeMeta[]) => void) {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  private async changed() {
    const trees = await this.trees()
    for (const l of this.listeners) l(trees)
  }

  async createTree(ctx: Context = BACKGROUND_CONTEXT): Promise<TreeMeta> {
    const model = this.options.defaultModel
    const conv = await this.harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: { extensions: [gense], ...(model && { model: { provider: model.provider, modelId: model.id } }) },
      },
      ctx,
    )
    const now = this.now()
    const meta: TreeMeta = { id: crypto.randomUUID(), title: DEFAULT_TITLE, pinned: false, createdAt: now, updatedAt: now }
    await this.db.run(`INSERT INTO trees (${COLUMNS}) VALUES (?, ?, ?, 0, ?, ?)`, meta.id, conv.id, meta.title, now, now)
    await this.changed()
    return meta
  }

  async updateTree(treeId: string, patch: { title?: string; pinned?: boolean }) {
    await this.row(treeId)
    if (patch.title !== undefined) await this.db.run('UPDATE trees SET title = ? WHERE id = ?', patch.title.trim() || DEFAULT_TITLE, treeId)
    if (patch.pinned !== undefined) await this.db.run('UPDATE trees SET pinned = ? WHERE id = ?', patch.pinned ? 1 : 0, treeId)
    await this.changed()
  }

  /** Removes the tree from the sidebar. pi-durable has no delete, so its conversation stays in storage. */
  async deleteTree(treeId: string, ctx: Context = BACKGROUND_CONTEXT) {
    const row = await this.db.get<TreeRow>(`SELECT ${COLUMNS} FROM trees WHERE id = ?`, treeId)
    if (row) await (await this.harness.conversation(row.rootId as ConversationId, ctx))?.abort(ctx)
    await this.db.run('DELETE FROM trees WHERE id = ?', treeId)
    await this.changed()
  }

  private async row(treeId: string) {
    const row = await this.db.get<TreeRow>(`SELECT ${COLUMNS} FROM trees WHERE id = ?`, treeId)
    if (!row) throw new Error('会话不存在')
    return row
  }

  private async conversation(treeId: string, ctx: Context) {
    const row = await this.row(treeId)
    const conv = await this.harness.conversation(row.rootId as ConversationId, ctx)
    if (!conv) throw new Error('会话不存在')
    return conv
  }

  /**
   * Submits user input. Resolves once the input is admitted; the answer arrives through `watch()`. A run that ends
   * without an answer leaves an `app.run-error` entry so the error survives a reload.
   */
  async send(treeId: string, input: { text: string; requestId: string; model?: ModelInfo; effort?: Effort }, ctx: Context = BACKGROUND_CONTEXT) {
    const text = input.text.trim()
    if (!text) throw new Error('消息不能为空')
    const row = await this.row(treeId)
    const conv = await this.conversation(treeId, ctx)

    const agent = await conv.agent(ctx)
    const model = input.model && (agent.model?.provider !== input.model.provider || agent.model?.modelId !== input.model.id)
      ? { provider: input.model.provider, modelId: input.model.id }
      : undefined
    const thinkingLevel = input.effort && agent.thinkingLevel !== input.effort ? input.effort : undefined
    if (model || thinkingLevel) await conv.configure({ ...(model && { model }), ...(thinkingLevel && { thinkingLevel }) }, ctx)

    const submission = await conv.submit({ type: 'input', content: text, requestId: input.requestId }, ctx)

    const title = row.title === DEFAULT_TITLE ? text.replace(/\s+/g, ' ').slice(0, TITLE_CHARS) : row.title
    await this.db.run('UPDATE trees SET title = ?, updatedAt = ? WHERE id = ?', title, this.now(), treeId)
    await this.changed()

    void submission.wait(ctx).then(
      async (settled) => {
        if (settled.status !== 'unanswered' || this.closed) return
        const data: RunErrorData = { reason: settled.reason, ...(settled.detail !== undefined && { detail: JSON.stringify(settled.detail) }) }
        await conv.submit({ type: 'write', entry: { kind: RUN_ERROR_KIND, data: { ...data } } }, ctx)
      },
      () => {},
    ).catch(() => {})
    return { submissionId: submission.id }
  }

  async abort(treeId: string, ctx: Context = BACKGROUND_CONTEXT) {
    await (await this.conversation(treeId, ctx)).abort(ctx)
  }

  /** Watch of the tree's conversation view; the caller starts and stops it. */
  async watch(treeId: string, ctx: Context = BACKGROUND_CONTEXT) {
    return (await this.conversation(treeId, ctx)).watch(ctx)
  }

  private closed = false

  async close(ctx: Context = BACKGROUND_CONTEXT) {
    this.closed = true
    this.listeners.clear()
    await this.harness.close(ctx)
  }
}
