// One user's conversations: a pi-durable Harness plus the sidebar index, in the same SQLite database (roadmap-3 D2).
// In stage 1 a tree is a single ownerless conversation, its root; tree ids are ours, conversation ids are pi-durable's.
// Each tree has a workspace directory, the conversation's cwd (D6).
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import { applySqliteMigrations, type SqliteDatabase } from '@earendil-works/chord/sqlite'
import type { Models } from '@earendil-works/pi-ai'
import {
  createRegistry,
  defineExtension,
  Harness,
  section,
  type ConversationId,
  type Extension,
  type HarnessOptions,
  type Wake,
} from '@earendil-works/pi-durable'
import type { PluginValue } from './catalog.ts'
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite'
import { createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools'
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import { Value } from 'typebox/value'
import { RUN_ERROR_KIND, type Effort, type ModelInfo, type RunErrorData, type ToolCallResult, type TreeMeta } from './protocol.ts'
import { DATA_DIR, SKILLS_DIR, toBase64, treeDir, Workspace, type EnvFactory } from './workspace.ts'
import { artifactExtension, artifactInput, emailExtension, saveArtifact, uiExtension } from './plugins/display.ts'
import { imageExtension } from './plugins/image.ts'
import { PluginStore, type PluginStoreOptions } from './plugins/store.ts'
import { attachmentsText, commandText, mentionsText, parseNote, type CommandNote, type Mention } from './notes.ts'
import { skillsSection, SkillStore } from './skills.ts'
import { webExtension } from './plugins/web.ts'

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

/** Plugins this core implements, by catalog id; each extension reads its user's settings when a tool runs. */
const PLUGINS: Record<string, (config: () => Record<string, PluginValue>) => Extension> = {
  artifact: artifactExtension,
  email: emailExtension,
  ui: uiExtension,
  web: webExtension,
  image: imageExtension,
}

const files = defineExtension({
  name: 'files',
  tools: [createReadTool(), createWriteTool(), createEditTool()],
  sections: [
    section('workspace', () =>
      [
        '这个会话有自己的工作区目录，也就是你的当前目录。需要保存的内容用 write 写成文件，用户能在文件面板里看到和下载。',
        `用户附加到消息的文件在工作区的 attachments/ 下。共享的 Skills 在 ${SKILLS_DIR}，只读。`,
        '用户消息里的 <command> 是用户选的 / 命令，<mentions> 是用户用 @ 提到的插件、文件或其他会话，按其中的说明处理。',
      ].join('\n'),
    ),
    section('skills', ({ env }, ctx) => (env ? skillsSection(env, ctx) : undefined)),
  ],
})

/** How much of a mentioned conversation goes into the message: its latest text. */
const MENTIONED_CHAT_CHARS = 20_000

export interface SpaceOptions {
  models: Models
  defaultModel: ModelInfo | null
  /** The user's files (roadmap-3 D6): an environment for a virtual working directory under /data. */
  env: EnvFactory
  /** Plugin settings the host supplies, and the key that seals the user's plugin secrets. */
  plugins?: Pick<PluginStoreOptions, 'defaults' | 'secretKey'>
  /** Passed through to the Harness: wake scheduling and settings belong to the host. */
  harness?: Pick<HarnessOptions, 'onWake' | 'setTimer' | 'now' | 'settings' | 'onReport'>
  /**
   * For hosts that wake the Harness themselves (a Durable Object alarm): awaited with the wake state before any call
   * that can start work, since `onWake` only reports after the commit. An early alarm is harmless, a missing one
   * strands the work.
   */
  arm?: (wake: Wake) => Promise<void>
  now?: () => number
}

type TreeRow = { id: string; rootId: number; title: string; pinned: number; createdAt: number; updatedAt: number }
const COLUMNS = 'id, rootId, title, pinned, createdAt, updatedAt'
const toMeta = ({ rootId: _, ...r }: TreeRow): TreeMeta => ({ ...r, pinned: r.pinned === 1 })

export class UserSpace {
  private readonly listeners = new Set<(trees: TreeMeta[]) => void>()
  private readonly db: SqliteDatabase
  readonly harness: Harness
  readonly workspace: Workspace
  readonly plugins: PluginStore
  readonly skills: SkillStore
  private readonly options: SpaceOptions

  private constructor(db: SqliteDatabase, harness: Harness, workspace: Workspace, plugins: PluginStore, skills: SkillStore, options: SpaceOptions) {
    this.db = db
    this.harness = harness
    this.workspace = workspace
    this.plugins = plugins
    this.skills = skills
    this.options = options
  }

  /** Opens the database's host tables and pi-durable storage. The Harness owns `db` and closes it in `close()`. */
  static async open(db: SqliteDatabase, options: SpaceOptions, ctx: Context = BACKGROUND_CONTEXT) {
    await applySqliteMigrations(db, migrations, { table: 'app_migrations' })
    const storage = await SqliteStorage.open(db, { prefix: 'pi_' })
    const plugins = await PluginStore.open(db, { ...options.plugins, available: Object.keys(PLUGINS) })
    const registry = createRegistry()
    const byName = new Map<string, Extension>()
    for (const e of [gense, files, ...Object.entries(PLUGINS).map(([id, make]) => make(() => plugins.resolved(id)))]) {
      registry.install(e)
      byName.set(e.name, e)
    }
    const workspace = new Workspace(options.env)
    const skills = await SkillStore.open(db, async () => workspace.env(DATA_DIR), ctx)
    // Conversations follow the host's selection, read at every resolution: a plugin switched on or off applies from the
    // next turn of every conversation (D8).
    const settings = {
      ...options.harness?.settings,
      get extensions() {
        return [gense, files, ...plugins.active().map((id) => byName.get(id)!)]
      },
    }
    const harness = await Harness.open(
      storage,
      { ...options.harness, settings, models: options.models, registry, env: ({ cwd }) => workspace.env(cwd ?? DATA_DIR) },
      ctx,
    )
    await options.arm?.(harness.wake())
    // Continue runs a previous process left unfinished (R32).
    harness.resume()
    return new UserSpace(db, harness, workspace, plugins, skills, options)
  }

  /** Arms the host's wake-up before a call that can start work. */
  private async arm() {
    await this.options.arm?.({ ...this.harness.wake(), active: true })
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
    const id = crypto.randomUUID()
    await this.workspace.createTree(id, ctx)
    const conv = await this.harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: { cwd: treeDir(id), ...(model && { model: { provider: model.provider, modelId: model.id } }) },
      },
      ctx,
    )
    const now = this.now()
    const meta: TreeMeta = { id, title: DEFAULT_TITLE, pinned: false, createdAt: now, updatedAt: now }
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

  /** Removes the tree and its workspace. pi-durable has no delete, so its conversation stays in storage. */
  async deleteTree(treeId: string, ctx: Context = BACKGROUND_CONTEXT) {
    const row = await this.db.get<TreeRow>(`SELECT ${COLUMNS} FROM trees WHERE id = ?`, treeId)
    if (row) {
      await this.arm()
      await (await this.harness.conversation(row.rootId as ConversationId, ctx))?.abort(ctx)
    }
    await this.db.run('DELETE FROM trees WHERE id = ?', treeId)
    await this.workspace.deleteTree(treeId, ctx)
    await this.changed()
  }

  private async row(treeId: string) {
    const row = await this.db.get<TreeRow>(`SELECT ${COLUMNS} FROM trees WHERE id = ?`, treeId)
    if (!row) throw new Error('会话不存在')
    return row
  }

  /** The workspace of an existing tree, for the file panel. */
  async files(treeId: string) {
    await this.row(treeId)
    return this.workspace
  }

  /** A tool called by a view rather than the model (MCP Apps `tools/call`); only the ones a view needs. */
  async callTool(treeId: string, name: string, args: unknown, ctx: Context = BACKGROUND_CONTEXT): Promise<ToolCallResult> {
    await this.row(treeId)
    if (name !== 'artifact_save') throw new Error(`界面不能调用 ${name}`)
    if (!this.plugins.active().includes('artifact')) throw new Error('Artifact 插件已关闭')
    if (!Value.Check(artifactInput, args)) throw new Error('参数无效')
    const path = await saveArtifact(await this.workspace.env(treeDir(treeId)), args, ctx)
    return { content: `已保存到 ${path}`, structuredContent: { path } }
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
  async send(
    treeId: string,
    input: {
      text: string
      requestId: string
      model?: ModelInfo
      effort?: Effort
      attachments?: string[]
      command?: CommandNote
      mentions?: Mention[]
    },
    ctx: Context = BACKGROUND_CONTEXT,
  ) {
    const text = input.text.trim()
    if (!text && !input.attachments?.length && !input.command) throw new Error('消息不能为空')
    const row = await this.row(treeId)
    const conv = await this.conversation(treeId, ctx)
    await this.arm()

    const agent = await conv.agent(ctx)
    const model = input.model && (agent.model?.provider !== input.model.provider || agent.model?.modelId !== input.model.id)
      ? { provider: input.model.provider, modelId: input.model.id }
      : undefined
    const thinkingLevel = input.effort && agent.thinkingLevel !== input.effort ? input.effort : undefined
    if (model || thinkingLevel) await conv.configure({ ...(model && { model }), ...(thinkingLevel && { thinkingLevel }) }, ctx)

    const attached = input.attachments?.length ? await this.workspace.attach(treeId, input.attachments, ctx) : []
    const content: (TextContent | ImageContent)[] = [{ type: 'text', text }]
    if (input.command) content.push({ type: 'text', text: commandText(input.command) })
    if (input.mentions?.length) content.push({ type: 'text', text: mentionsText(await this.mentioned(input.mentions, ctx)) })
    if (attached.length) content.push({ type: 'text', text: attachmentsText(attached.map((a) => a.path)) })
    for (const a of attached) if (a.mimeType.startsWith('image/')) content.push({ type: 'image', data: toBase64(a.bytes), mimeType: a.mimeType })
    const submission = await conv.submit({ type: 'input', content, requestId: input.requestId }, ctx)

    const named = text || input.command?.label || attached.map((a) => a.path.slice(a.path.lastIndexOf('/') + 1)).join('、')
    const title = row.title === DEFAULT_TITLE ? named.replace(/\s+/g, ' ').slice(0, TITLE_CHARS) : row.title
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

  /** What the model should do with each `@` mention (R18). */
  private async mentioned(mentions: Mention[], ctx: Context) {
    const active = this.plugins.active()
    return Promise.all(
      mentions.map(async (m) => {
        let detail: string
        if (m.kind === 'plugin') detail = active.includes(m.id) ? '本轮优先使用这个插件的工具。' : '这个插件现在没有开启；如果需要它，请用户先在“定制”页开启。'
        else if (m.kind === 'workspace') detail = `用 read 读取 ${m.id}。`
        else detail = await this.transcript(m.id, ctx).then(
          (t) => `用户提到的另一个会话，内容如下，作为本轮的上下文：\n${t}`,
          () => '这个会话已经不存在。',
        )
        return { ...m, detail }
      }),
    )
  }

  /** A conversation's user and assistant text, newest last, cut to its latest part. */
  private async transcript(treeId: string, ctx: Context) {
    const { messages } = await (await this.conversation(treeId, ctx)).context(ctx)
    const lines: string[] = []
    for (const m of messages) {
      if (m.role !== 'user' && m.role !== 'assistant') continue
      const blocks = typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content
      const text = blocks
        .flatMap((b) => (b.type === 'text' && !parseNote(b.text) ? [b.text] : []))
        .join('\n')
        .trim()
      if (text) lines.push(`${m.role === 'user' ? '用户' : '助手'}：${text}`)
    }
    const all = lines.join('\n\n')
    return all.length > MENTIONED_CHAT_CHARS ? `…\n${all.slice(-MENTIONED_CHAT_CHARS)}` : all || '（空会话）'
  }

  async abort(treeId: string, ctx: Context = BACKGROUND_CONTEXT) {
    await this.arm()
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
