// One user's conversations: a pi-durable Harness plus the sidebar index, in the same SQLite database (roadmap-3 D2).
// A tree is a main conversation and the branches forked from it, all ownerless; tree and branch ids are ours,
// conversation ids are pi-durable's. Each tree has one workspace directory, every branch's cwd (D6).
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import { applySqliteMigrations, type SqliteDatabase } from '@earendil-works/chord/sqlite'
import {
  createRegistry,
  defineExtension,
  Harness,
  section,
  LiveDoc,
  UserEntry,
  type Conversation,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type Extension,
  type HarnessOptions,
  type Wake,
} from '@earendil-works/pi-durable'
import type { PluginValue } from './catalog.ts'
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite'
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import { Value } from 'typebox/value'
import {
  RUN_ERROR_KIND,
  type BranchesState,
  type BranchMeta,
  type BranchRole,
  type BranchStatus,
  type Effort,
  type ModelInfo,
  type RunErrorData,
  type ToolCallResult,
  type TreeMeta,
} from './protocol.ts'
import { DATA_DIR, SKILLS_DIR, toBase64, treeDir, Workspace, type EnvFactory } from './workspace.ts'
import { artifactExtension, artifactInput, emailExtension, saveArtifact, uiExtension } from './plugins/display.ts'
import { imageExtension } from './plugins/image.ts'
import { PluginStore, type PluginStoreOptions } from './plugins/store.ts'
import { ModelAccounts } from './credentials.ts'
import type { ModelSetup } from './models.ts'
import { fileTools } from './ledger.ts'
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
  {
    // Branches (stage 4); each existing tree gets its main branch.
    version: 2,
    statements: [
      'CREATE TABLE branches (id TEXT PRIMARY KEY, treeId TEXT NOT NULL, conversationId INTEGER NOT NULL, parentId TEXT, forkEntryId INTEGER, role TEXT NOT NULL, mode TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL)',
      'CREATE INDEX branches_tree ON branches (treeId, createdAt)',
      'CREATE INDEX branches_conversation ON branches (conversationId)',
      "ALTER TABLE trees ADD COLUMN activeBranchId TEXT NOT NULL DEFAULT ''",
      "INSERT INTO branches (id, treeId, conversationId, parentId, forkEntryId, role, mode, title, status, createdAt) SELECT lower(hex(randomblob(16))), id, rootId, NULL, NULL, 'main', 'fork', title, 'idle', createdAt FROM trees",
      'UPDATE trees SET activeBranchId = (SELECT b.id FROM branches b WHERE b.treeId = trees.id)',
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
  tools: fileTools(),
  sections: [
    section('workspace', () =>
      [
        '这个会话有自己的工作区目录，也就是你的当前目录，同一棵会话树的各个分叉共用它。需要保存的内容用 write 写成文件，用户能在文件面板里看到和下载。',
        '修改或删除已有文件之前要先 read 它；如果文件在你读过之后被别人改过，write/edit/delete 会报错，重新 read 后再改。',
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
  /** The host's providers; each user adds their own with `accounts` (R62). */
  models: ModelSetup
  /** Seals the user's plugin secrets and model credentials. */
  secretKey?: string
  /** Whether users may run subscription (OAuth) logins on this host. */
  oauth?: boolean
  /** The user's files (roadmap-3 D6): an environment for a virtual working directory under /data. */
  env: EnvFactory
  /** Plugin settings the host supplies, and the key that seals the user's plugin secrets. */
  plugins?: Pick<PluginStoreOptions, 'defaults'>
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

type TreeRow = { id: string; rootId: number; title: string; pinned: number; createdAt: number; updatedAt: number; activeBranchId: string }
const COLUMNS = 'id, rootId, title, pinned, createdAt, updatedAt, activeBranchId'
const toMeta = ({ rootId: _, activeBranchId: __, ...r }: TreeRow): TreeMeta => ({ ...r, pinned: r.pinned === 1 })

type BranchRow = {
  id: string
  treeId: string
  conversationId: number
  parentId: string | null
  forkEntryId: number | null
  role: BranchRole
  /** `fork` continues its parent's transcript; `new` is a conversation of its own. */
  mode: 'fork' | 'new'
  title: string
  status: BranchStatus
  createdAt: number
}
const BRANCH_COLUMNS = 'id, treeId, conversationId, parentId, forkEntryId, role, mode, title, status, createdAt'

/** How much of a branch's newest answer the tree map shows. */
const PREVIEW_CHARS = 160
/** Newest entries searched for that answer. */
const PREVIEW_ENTRIES = 20

const entryText = (e: EntryRecord) =>
  (e.model ?? [])
    .flatMap((m) => (typeof m.content === 'string' ? [m.content] : m.content.flatMap((b) => (b.type === 'text' ? [b.text] : []))))
    .join('')
    .trim()

const titleOf = (named: string) => named.replace(/\s+/g, ' ').slice(0, TITLE_CHARS)

export class UserSpace {
  private readonly listeners = new Set<(trees: TreeMeta[]) => void>()
  private readonly branchListeners = new Set<(treeId: string) => void>()
  /** Whether each conversation last ran, from its `pi.live` commits; a change updates its tree's branches. */
  private readonly running = new Map<number, boolean>()
  private readonly db: SqliteDatabase
  readonly harness: Harness
  readonly workspace: Workspace
  readonly plugins: PluginStore
  readonly skills: SkillStore
  readonly accounts: ModelAccounts
  private readonly options: SpaceOptions

  private constructor(db: SqliteDatabase, harness: Harness, workspace: Workspace, plugins: PluginStore, skills: SkillStore, accounts: ModelAccounts, options: SpaceOptions) {
    this.db = db
    this.harness = harness
    this.workspace = workspace
    this.plugins = plugins
    this.skills = skills
    this.accounts = accounts
    this.options = options
    harness.subscribeCommits((publication) => {
      for (const c of publication.changes) {
        if (c.type !== 'document' || c.record.kind !== 'pi.live' || c.conversationId === undefined) continue
        const run = !!(c.value as { run?: unknown } | null)?.run
        if (this.running.get(c.conversationId) === run) continue
        this.running.set(c.conversationId, run)
        // Listeners must not call the Session; this one reads only our tables, after the commit.
        const id = c.conversationId
        queueMicrotask(() => void this.conversationChanged(id).catch(() => {}))
      }
    })
  }

  /** Opens the database's host tables and pi-durable storage. The Harness owns `db` and closes it in `close()`. */
  static async open(db: SqliteDatabase, options: SpaceOptions, ctx: Context = BACKGROUND_CONTEXT) {
    await applySqliteMigrations(db, migrations, { table: 'app_migrations' })
    const storage = await SqliteStorage.open(db, { prefix: 'pi_' })
    const plugins = await PluginStore.open(db, { ...options.plugins, secretKey: options.secretKey, available: Object.keys(PLUGINS) })
    const registry = createRegistry()
    const byName = new Map<string, Extension>()
    for (const e of [gense, files, ...Object.entries(PLUGINS).map(([id, make]) => make(() => plugins.resolved(id)))]) {
      registry.install(e)
      byName.set(e.name, e)
    }
    const accounts = await ModelAccounts.open(db, { host: options.models, secretKey: options.secretKey, oauth: options.oauth ?? false })
    const workspace = new Workspace(options.env)
    const skills = await SkillStore.open(db, async () => workspace.env(DATA_DIR), ctx)
    // Conversations follow the host's selection, read at every resolution: a plugin switched on or off applies from the
    // next turn of every conversation (D8). Every branch of a tree gets the same selection, so forks share its prefix (D3).
    const settings = {
      ...options.harness?.settings,
      get extensions() {
        return [gense, files, ...plugins.active().map((id) => byName.get(id)!)]
      },
    }
    const harness = await Harness.open(
      storage,
      { ...options.harness, settings, models: accounts.models, registry, env: ({ cwd }) => workspace.env(cwd ?? DATA_DIR) },
      ctx,
    )
    const space = new UserSpace(db, harness, workspace, plugins, skills, accounts, options)
    await options.arm?.(harness.wake())
    // Continue runs a previous process left unfinished (R32).
    harness.resume()
    return space
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

  /** Called with a tree's id whenever its branches change: one added, retitled, or starting or ending a run. */
  subscribeBranches(listener: (treeId: string) => void) {
    this.branchListeners.add(listener)
    return () => void this.branchListeners.delete(listener)
  }

  private async changed() {
    const trees = await this.trees()
    for (const l of this.listeners) l(trees)
  }

  private branchesChanged(treeId: string) {
    for (const l of this.branchListeners) l(treeId)
  }

  private async conversationChanged(conversationId: number) {
    const row = await this.db.get<{ treeId: string }>('SELECT treeId FROM branches WHERE conversationId = ?', conversationId)
    if (row && !this.closed) this.branchesChanged(row.treeId)
  }

  async createTree(ctx: Context = BACKGROUND_CONTEXT): Promise<TreeMeta> {
    const model = await this.accounts.defaultModel()
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
    const main: BranchRow = { id: crypto.randomUUID(), treeId: id, conversationId: conv.id, parentId: null, forkEntryId: null, role: 'main', mode: 'new', title: '', status: 'idle', createdAt: now }
    await this.insertBranch(main)
    await this.db.run(`INSERT INTO trees (${COLUMNS}) VALUES (?, ?, ?, 0, ?, ?, ?)`, meta.id, conv.id, meta.title, now, now, main.id)
    await this.changed()
    return meta
  }

  private insertBranch(b: BranchRow) {
    return this.db.run(
      `INSERT INTO branches (${BRANCH_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      b.id,
      b.treeId,
      b.conversationId,
      b.parentId,
      b.forkEntryId,
      b.role,
      b.mode,
      b.title,
      b.status,
      b.createdAt,
    )
  }

  async updateTree(treeId: string, patch: { title?: string; pinned?: boolean }) {
    await this.row(treeId)
    if (patch.title !== undefined) await this.db.run('UPDATE trees SET title = ? WHERE id = ?', patch.title.trim() || DEFAULT_TITLE, treeId)
    if (patch.pinned !== undefined) await this.db.run('UPDATE trees SET pinned = ? WHERE id = ?', patch.pinned ? 1 : 0, treeId)
    await this.changed()
  }

  /** Removes the tree and its workspace. pi-durable has no delete, so its conversations stay in storage. */
  async deleteTree(treeId: string, ctx: Context = BACKGROUND_CONTEXT) {
    const branches = await this.db.all<BranchRow>(`SELECT ${BRANCH_COLUMNS} FROM branches WHERE treeId = ?`, treeId)
    if (branches.length) await this.arm()
    for (const b of branches) await (await this.harness.conversation(b.conversationId as ConversationId, ctx))?.abort(ctx)
    await this.db.run('DELETE FROM branches WHERE treeId = ?', treeId)
    await this.db.run('DELETE FROM trees WHERE id = ?', treeId)
    await this.workspace.deleteTree(treeId, ctx)
    await this.changed()
  }

  private async row(treeId: string) {
    const row = await this.db.get<TreeRow>(`SELECT ${COLUMNS} FROM trees WHERE id = ?`, treeId)
    if (!row) throw new Error('会话不存在')
    return row
  }

  /** The tree and one of its branches: `branchId`, or the active one (the main branch when that is gone). */
  private async branchRow(treeId: string, branchId?: string) {
    const tree = await this.row(treeId)
    const select = `SELECT ${BRANCH_COLUMNS} FROM branches WHERE treeId = ? AND `
    const branch =
      (await this.db.get<BranchRow>(`${select}id = ?`, treeId, branchId ?? tree.activeBranchId)) ??
      (branchId === undefined ? await this.db.get<BranchRow>(`${select}role = 'main'`, treeId) : undefined)
    if (!branch) throw new Error('这个分叉不存在')
    return { tree, branch }
  }

  private async open(branch: BranchRow, ctx: Context) {
    const conv = await this.harness.conversation(branch.conversationId as ConversationId, ctx)
    if (!conv) throw new Error('会话不存在')
    return conv
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

  /** The tree's branches for its map and version arrows. */
  async branches(treeId: string, ctx: Context = BACKGROUND_CONTEXT): Promise<BranchesState> {
    const tree = await this.row(treeId)
    const rows = await this.db.all<BranchRow>(`SELECT ${BRANCH_COLUMNS} FROM branches WHERE treeId = ? ORDER BY createdAt, rowid`, treeId)
    const branches = await Promise.all(rows.map((r) => this.branchMeta(r, ctx)))
    return { branches, activeBranchId: rows.some((r) => r.id === tree.activeBranchId) ? tree.activeBranchId : rows[0]!.id, versions: await this.versions(rows, ctx) }
  }

  private async branchMeta(row: BranchRow, ctx: Context): Promise<BranchMeta> {
    const conv = await this.harness.conversation(row.conversationId as ConversationId, ctx)
    const live = await this.harness.snapshot(LiveDoc, row.conversationId as ConversationId, ctx)
    const { items } = conv ? await conv.entries({}, PREVIEW_ENTRIES, undefined, ctx) : { items: [] }
    const answer = items.find((e) => e.kind === 'pi.assistant' && entryText(e))
    const { treeId: _, mode: __, ...meta } = row
    return {
      ...meta,
      status: live?.run ? 'running' : row.status,
      lastEntryId: items[0]?.id ?? row.forkEntryId,
      preview: answer ? entryText(answer).replace(/\s+/g, ' ').slice(0, PREVIEW_CHARS) : '',
    }
  }

  /**
   * Versions of each message that has some (R37): the branches that continue the same entry with a message of their
   * own. The branch that wrote the entry counts when its own next entry is a message, that is when it continued there.
   */
  private async versions(rows: BranchRow[], ctx: Context) {
    const groups = new Map<string, BranchRow[]>()
    for (const r of rows) if (r.role === 'user' && r.title) groups.set(String(r.forkEntryId ?? 'start'), [...(groups.get(String(r.forkEntryId ?? 'start')) ?? []), r])
    const out: Record<string, string[]> = {}
    for (const [key, forks] of groups) {
      const owner = key === 'start' ? rows.find((r) => r.role === 'main' && r.title) : await this.continuing(rows, forks[0]!, ctx)
      const ids = [...(owner && !forks.includes(owner) ? [owner] : []), ...forks].map((r) => r.id)
      if (ids.length > 1) out[key] = ids
    }
    return out
  }

  /** The branch that wrote `fork`'s fork entry, when it went on with a message right after it. */
  private async continuing(rows: BranchRow[], fork: BranchRow, ctx: Context) {
    const at = fork.forkEntryId!
    const conv = await this.harness.conversation(fork.conversationId as ConversationId, ctx)
    const entry = conv && (await conv.entries({ minEntryId: at as EntryId, maxEntryId: at as EntryId }, 1, undefined, ctx)).items[0]
    const owner = entry && rows.find((r) => r.conversationId === entry.conversationId)
    if (!owner) return undefined
    const next = (await (await this.open(owner, ctx)).entries({ minEntryId: (at + 1) as EntryId, order: 'ascending' }, 1, undefined, ctx)).items[0]
    return next?.kind === UserEntry.kind ? owner : undefined
  }

  /**
   * A user branch that continues `at`, an entry of `from`'s transcript, and becomes the active one. Without `at` it
   * starts empty beside the first message, with `from`'s model.
   */
  private async addBranch(tree: TreeRow, from: BranchRow, at: number | null, ctx: Context) {
    const parent = await this.open(from, ctx)
    let conv: Conversation
    if (at === null) {
      const agent = await parent.agent(ctx)
      conv = await this.harness.createConversation(
        {
          ownership: { kind: 'ownerless' },
          agent: { cwd: treeDir(tree.id), ...(agent.model && { model: agent.model }), ...(agent.thinkingLevel && { thinkingLevel: agent.thinkingLevel }) },
        },
        ctx,
      )
    } else conv = await parent.fork(at as EntryId, { ownership: { kind: 'ownerless' } }, ctx)
    const branch: BranchRow = {
      id: crypto.randomUUID(),
      treeId: tree.id,
      conversationId: conv.id,
      parentId: from.id,
      forkEntryId: at,
      role: 'user',
      mode: at === null ? 'new' : 'fork',
      title: '',
      status: 'idle',
      createdAt: this.now(),
    }
    await this.insertBranch(branch)
    await this.db.run('UPDATE trees SET activeBranchId = ? WHERE id = ?', branch.id, tree.id)
    return { branch, conv }
  }

  /** A new branch continuing entry `at` of `branchId` (R36); the user goes on in it. */
  async fork(treeId: string, branchId: string, at: number, ctx: Context = BACKGROUND_CONTEXT): Promise<BranchMeta> {
    const { tree, branch: from } = await this.branchRow(treeId, branchId)
    const { branch } = await this.addBranch(tree, from, at, ctx)
    this.branchesChanged(treeId)
    return this.branchMeta(branch, ctx)
  }

  /** The user entry `entryId` of the conversation's transcript, and the entry before it (null for the first). */
  private async userEntry(conv: Conversation, entryId: number, ctx: Context) {
    const { entries } = await conv.context(ctx)
    const i = entries.findIndex((e) => e.id === entryId)
    if (i < 0 || entries[i]!.kind !== UserEntry.kind) throw new Error('这条消息不存在')
    return { entry: entries[i]!, before: i > 0 ? entries[i - 1]!.id : null }
  }

  /** Asks the user entry `entryId` again in a new branch beside it (R37), with the same content. */
  async regenerate(
    treeId: string,
    branchId: string,
    entryId: number,
    input: { requestId: string; model?: ModelInfo; effort?: Effort },
    ctx: Context = BACKGROUND_CONTEXT,
  ): Promise<BranchMeta> {
    const { tree, branch: from } = await this.branchRow(treeId, branchId)
    await this.checkModel(input.model)
    const { entry, before } = await this.userEntry(await this.open(from, ctx), entryId, ctx)
    const message = entry.model?.[0]
    const content: (TextContent | ImageContent)[] =
      message?.role !== 'user' ? [] : typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : [...message.content]
    const { branch, conv } = await this.addBranch(tree, from, before, ctx)
    const first = content[0]?.type === 'text' ? content[0].text : ''
    await this.submit(tree, branch, conv, content, input, parseNote(first) ? '' : first, ctx)
    return this.branchMeta({ ...branch, title: branch.title || titleOf(first) }, ctx)
  }

  /** Only models the user has: a stale pick or a provider without the user's credentials would fail mid-run. */
  private async checkModel(model: ModelInfo | undefined) {
    if (model && !(await this.accounts.list()).some((m) => m.provider === model.provider && m.id === model.id)) throw new Error('这个模型不可用，请重新选择')
  }

  /**
   * Submits user input to a branch, the active one by default; with `replace`, to a new branch beside that user entry
   * (an edit, R37). Resolves once the input is admitted; the answer arrives through `watch()`.
   */
  async send(
    treeId: string,
    input: {
      text: string
      requestId: string
      branchId?: string
      replace?: number
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
    const found = await this.branchRow(treeId, input.branchId)
    const { tree } = found
    let { branch } = found
    let conv = await this.open(branch, ctx)
    await this.checkModel(input.model)
    if (input.replace !== undefined) {
      const { before } = await this.userEntry(conv, input.replace, ctx)
      ;({ branch, conv } = await this.addBranch(tree, branch, before, ctx))
    }

    const attached = input.attachments?.length ? await this.workspace.attach(treeId, input.attachments, ctx) : []
    const content: (TextContent | ImageContent)[] = [{ type: 'text', text }]
    if (input.command) content.push({ type: 'text', text: commandText(input.command) })
    if (input.mentions?.length) content.push({ type: 'text', text: mentionsText(await this.mentioned(treeId, input.mentions, ctx)) })
    if (attached.length) content.push({ type: 'text', text: attachmentsText(attached.map((a) => a.path)) })
    for (const a of attached) if (a.mimeType.startsWith('image/')) content.push({ type: 'image', data: toBase64(a.bytes), mimeType: a.mimeType })
    const named = text || input.command?.label || attached.map((a) => a.path.slice(a.path.lastIndexOf('/') + 1)).join('、')
    const submissionId = await this.submit(tree, branch, conv, content, input, named, ctx)
    return { branchId: branch.id, submissionId }
  }

  /**
   * Admits input to a branch's conversation with the chosen model and effort, and names the branch (and the tree, for
   * the main branch) after its first message. A run that ends without an answer leaves an `app.run-error` entry so the
   * error survives a reload.
   */
  private async submit(
    tree: TreeRow,
    branch: BranchRow,
    conv: Conversation,
    content: (TextContent | ImageContent)[],
    input: { requestId: string; model?: ModelInfo; effort?: Effort },
    named: string,
    ctx: Context,
  ) {
    await this.arm()
    const agent = await conv.agent(ctx)
    const model = input.model && (agent.model?.provider !== input.model.provider || agent.model?.modelId !== input.model.id)
      ? { provider: input.model.provider, modelId: input.model.id }
      : undefined
    const thinkingLevel = input.effort && agent.thinkingLevel !== input.effort ? input.effort : undefined
    if (model || thinkingLevel) await conv.configure({ ...(model && { model }), ...(thinkingLevel && { thinkingLevel }) }, ctx)
    const submission = await conv.submit({ type: 'input', content, requestId: input.requestId }, ctx)

    if (!branch.title && named) await this.db.run('UPDATE branches SET title = ? WHERE id = ?', titleOf(named), branch.id)
    const title = branch.role === 'main' && tree.title === DEFAULT_TITLE && named ? titleOf(named) : tree.title
    await this.db.run('UPDATE trees SET title = ?, updatedAt = ? WHERE id = ?', title, this.now(), tree.id)
    await this.changed()
    this.branchesChanged(tree.id)

    void submission.wait(ctx).then(
      async (settled) => {
        if (settled.status !== 'unanswered' || this.closed) return
        const data: RunErrorData = { reason: settled.reason, ...(settled.detail !== undefined && { detail: JSON.stringify(settled.detail) }) }
        await conv.submit({ type: 'write', entry: { kind: RUN_ERROR_KIND, data: { ...data } } }, ctx)
      },
      () => {},
    ).catch(() => {})
    return submission.id
  }

  /** What the model should do with each `@` mention (R18). */
  private async mentioned(treeId: string, mentions: Mention[], ctx: Context) {
    const active = this.plugins.active()
    return Promise.all(
      mentions.map(async (m) => {
        let detail: string
        if (m.kind === 'plugin') detail = active.includes(m.id) ? '本轮优先使用这个插件的工具。' : '这个插件现在没有开启；如果需要它，请用户先在“定制”页开启。'
        else if (m.kind === 'workspace')
          detail = await this.workspace.mentioned(treeId, m.id, ctx).then(
            (path) => `用 read 读取 ${path}。`,
            (e: unknown) => `无法读取这个文件：${e instanceof Error ? e.message : String(e)}`,
          )
        else detail = await this.transcript(m.id, ctx).then(
          (t) => `用户提到的另一个会话，内容如下，作为本轮的上下文：\n${t}`,
          () => '这个会话已经不存在。',
        )
        return { ...m, detail }
      }),
    )
  }

  /** A tree's user and assistant text on its active branch, newest last, cut to its latest part. */
  private async transcript(treeId: string, ctx: Context) {
    const { messages } = await (await this.open((await this.branchRow(treeId)).branch, ctx)).context(ctx)
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

  async abort(treeId: string, branchId?: string, ctx: Context = BACKGROUND_CONTEXT) {
    const { branch } = await this.branchRow(treeId, branchId)
    await this.arm()
    await (await this.open(branch, ctx)).abort(ctx)
  }

  /** Watch of one branch's view, `branchId` or the active one, which it makes the active one; the caller starts and stops it. */
  async watch(treeId: string, branchId?: string, ctx: Context = BACKGROUND_CONTEXT) {
    const { tree, branch } = await this.branchRow(treeId, branchId)
    if (tree.activeBranchId !== branch.id) await this.db.run('UPDATE trees SET activeBranchId = ? WHERE id = ?', branch.id, treeId)
    return { branchId: branch.id, watch: await (await this.open(branch, ctx)).watch(ctx) }
  }

  private closed = false

  async close(ctx: Context = BACKGROUND_CONTEXT) {
    this.closed = true
    this.listeners.clear()
    this.branchListeners.clear()
    await this.harness.close(ctx)
  }
}
