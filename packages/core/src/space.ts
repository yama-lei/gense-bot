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
  type Submission,
  type ToolExecutionApi,
  type Wake,
} from '@earendil-works/pi-durable'
import type { PluginValue } from './catalog.ts'
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite'
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import { Value } from 'typebox/value'
import {
  BRIEF_KIND,
  EVENT_KIND,
  RUN_ERROR_KIND,
  type BranchesState,
  type EventData,
  type ScheduleInfo,
  type ScheduleRule,
  type WebhookInfo,
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
import { noSandbox, sandboxExtension } from './plugins/sandbox.ts'
import { PluginStore, Sealer, type PluginStoreOptions } from './plugins/store.ts'
import { ModelAccounts } from './credentials.ts'
import type { ModelSetup } from './models.ts'
import { fileTools } from './ledger.ts'
import {
  agentBrief,
  agentTask,
  checkRule,
  checkTimeZone,
  eventText,
  MAX_AGENTS,
  nextRun,
  reportTool,
  scheduleTask,
  spawnTool,
  SUMMARIZE_PROMPT,
  verifySignature,
  WEBHOOK_MAX_BODY,
  webhookContent,
  type AgentEnd,
  type AgentInput,
  type EventDraft,
} from './events.ts'
import { attachmentsText, commandText, mentionsText, parseNote, type CommandNote, type Mention } from './notes.ts'
import { skillsSection, SkillStore } from './skills.ts'
import { webExtension } from './plugins/web.ts'
import { json } from './http.ts'

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
  {
    // Events, schedules and webhooks (stage 6).
    version: 3,
    statements: [
      'CREATE TABLE events (id TEXT PRIMARY KEY, treeId TEXT NOT NULL, branchId TEXT NOT NULL, data TEXT NOT NULL, wake INTEGER NOT NULL, idempotencyKey TEXT UNIQUE, createdAt INTEGER NOT NULL, deliveredAt INTEGER)',
      'CREATE INDEX events_branch ON events (branchId, createdAt)',
      'CREATE TABLE schedules (id TEXT PRIMARY KEY, treeId TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL, rule TEXT NOT NULL, tz TEXT NOT NULL, enabled INTEGER NOT NULL, taskId INTEGER, nextRunAt INTEGER, lastRunAt INTEGER, lastResult TEXT NOT NULL, createdAt INTEGER NOT NULL)',
      'CREATE TABLE webhooks (id TEXT PRIMARY KEY, treeId TEXT NOT NULL, secret TEXT NOT NULL, createdAt INTEGER NOT NULL, lastUsedAt INTEGER)',
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
  sandbox: sandboxExtension,
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

/** Events that may wake one branch in a minute; more only land in its transcript (R47). */
const WAKES_PER_MINUTE = 6

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
  /** The environment's `exec` runs in this user's sandbox, so the sandbox plugin and its `bash` are offered (D7). */
  sandbox?: boolean
  /** Path the host serves this user's webhooks under, `hooksPath(userId)`; without it there are none (R50). */
  hooksPath?: () => string | undefined
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

type ScheduleRow = Omit<ScheduleInfo, 'rule' | 'enabled'> & { rule: string; enabled: number; taskId: number | null }
const SCHEDULE_COLUMNS = 'id, treeId, name, prompt, rule, tz, enabled, taskId, nextRunAt, lastRunAt, lastResult, createdAt'
const toSchedule = ({ rule, enabled, taskId: _, ...r }: ScheduleRow): ScheduleInfo => ({ ...r, rule: JSON.parse(rule) as ScheduleRule, enabled: enabled === 1 })

type WebhookRow = { id: string; treeId: string; secret: string; createdAt: number; lastUsedAt: number | null }
type EventRow = { id: string; treeId: string; branchId: string; data: string; wake: number }

/** The tasks and tools of events, bound to their space once it exists. */
function eventsExtension(space: () => UserSpace) {
  const schedule = scheduleTask(() => (id, at, ctx) => space().fireSchedule(id, at, ctx))
  const agent = agentTask(() => ({ run: (input, ctx) => space().runAgent(input, ctx), finish: (input, end, ctx) => space().finishAgent(input, end, ctx) }))
  return {
    schedule,
    agent,
    extension: defineExtension({
      name: 'events',
      tools: [
        reportTool(() => (conversationId, report, ctx) => space().report(conversationId, report, ctx)),
        spawnTool(() => (api, args, ctx) => space().spawn(api, args, ctx)),
      ],
      tasks: [schedule, agent],
      sections: [
        section('events', () =>
          [
            '用户消息里的 <event> 不是用户本人写的，而是来自定时任务、Webhook、子 agent 或其他分叉的通知；按其中的内容处理，回答时说明你做了什么。',
            `一件事能拆成几个互不依赖、各自要花不少步骤的子任务时（例如分头调研几家公司），可以用 agent_spawn 派出子 agent 并行去做，最多同时 ${MAX_AGENTS} 个。派出后马上告诉用户，不要等；它们的汇报会以 <event> 陆续到达，到齐后再综合回答。简单的事自己做。`,
          ].join('\n'),
        ),
      ],
    }),
  }
}

export class UserSpace {
  private readonly listeners = new Set<(trees: TreeMeta[]) => void>()
  private readonly branchListeners = new Set<(treeId: string) => void>()
  private readonly automationListeners = new Set<() => void>()
  /** Whether each conversation last ran, from its `pi.live` commits; a change updates its tree's branches. */
  private readonly running = new Map<number, boolean>()
  private readonly db: SqliteDatabase
  readonly harness: Harness
  readonly workspace: Workspace
  readonly plugins: PluginStore
  readonly skills: SkillStore
  readonly accounts: ModelAccounts
  private readonly options: SpaceOptions
  private readonly sealer: Sealer | undefined
  /** Set once in `open`, before the Harness resumes work. */
  private schedule!: ReturnType<typeof eventsExtension>['schedule']
  private agentTask!: ReturnType<typeof eventsExtension>['agent']

  private constructor(db: SqliteDatabase, harness: Harness, workspace: Workspace, plugins: PluginStore, skills: SkillStore, accounts: ModelAccounts, options: SpaceOptions) {
    this.sealer = options.secretKey ? new Sealer(options.secretKey) : undefined
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
    const plugins = await PluginStore.open(db, { ...options.plugins, secretKey: options.secretKey, available: Object.keys(PLUGINS).filter((id) => id !== 'sandbox' || options.sandbox) })
    const registry = createRegistry()
    const byName = new Map<string, Extension>()
    let space: UserSpace | undefined
    const events = eventsExtension(() => {
      if (!space) throw new Error('UserSpace is not open')
      return space
    })
    for (const e of [gense, files, events.extension, noSandbox, ...Object.entries(PLUGINS).map(([id, make]) => make(() => plugins.resolved(id)))]) {
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
        const active = plugins.active()
        return [gense, files, events.extension, ...active.map((id) => byName.get(id)!), ...(active.includes('sandbox') ? [] : [noSandbox])]
      },
    }
    const harness = await Harness.open(
      storage,
      { ...options.harness, settings, models: accounts.models, registry, env: ({ cwd }) => workspace.env(cwd ?? DATA_DIR) },
      ctx,
    )
    space = new UserSpace(db, harness, workspace, plugins, skills, accounts, options)
    space.schedule = events.schedule
    space.agentTask = events.agent
    await options.arm?.(harness.wake())
    // Events stored but not yet delivered when a previous process stopped; delivery is idempotent.
    for (const row of await db.all<EventRow>('SELECT id, treeId, branchId, data, wake FROM events WHERE deliveredAt IS NULL')) {
      await space.deliver(row, ctx).catch(() => {})
    }
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
    for (const s of await this.db.all<ScheduleRow>(`SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE treeId = ?`, treeId)) await this.stopSchedule(s, ctx)
    await this.db.run('DELETE FROM schedules WHERE treeId = ?', treeId)
    await this.db.run('DELETE FROM webhooks WHERE treeId = ?', treeId)
    await this.db.run('DELETE FROM events WHERE treeId = ?', treeId)
    this.automationsChanged()
    // The main branch first, with its background work: a subagent's anchor then does not report into a removed tree.
    for (const b of branches.sort((a, b) => Number(b.role === 'main') - Number(a.role === 'main')))
      await (await this.harness.conversation(b.conversationId as ConversationId, ctx))?.abort(ctx, { background: b.role === 'main' })
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
    const conv = at === null ? await this.emptyLike(tree.id, parent, ctx) : await parent.fork(at as EntryId, { ownership: { kind: 'ownerless' } }, ctx)
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

  /** A conversation of the tree that starts empty, with `like`'s model and effort. */
  private async emptyLike(treeId: string, like: Conversation, ctx: Context) {
    const agent = await like.agent(ctx)
    return this.harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: { cwd: treeDir(treeId), ...(agent.model && { model: agent.model }), ...(agent.thinkingLevel && { thinkingLevel: agent.thinkingLevel }) },
      },
      ctx,
    )
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

  /** Admits input to a branch's conversation with the chosen model and effort. */
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
    await this.answered(tree, branch, conv, submission, named, ctx)
    return submission.id
  }

  /**
   * Names the branch (and the tree, for the main branch) after its first message, and leaves an `app.run-error` entry
   * when the run ends without an answer, so the error survives a reload.
   */
  private async answered(tree: TreeRow, branch: BranchRow, conv: Conversation, submission: Submission, named: string, ctx: Context) {
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

  // --- Events (R46–R48) ---

  private async mainBranch(treeId: string) {
    const branch = await this.db.get<BranchRow>(`SELECT ${BRANCH_COLUMNS} FROM branches WHERE treeId = ? AND role = 'main'`, treeId)
    if (!branch) throw new Error('会话不存在')
    return branch
  }

  /**
   * Delivers an Event to a branch of the tree, the main one by default. With `key`, an Event already delivered under
   * the same key is returned instead (a repeated webhook call, a schedule firing again after a crash).
   */
  async emit(treeId: string, draft: EventDraft, options: { branchId?: string; key?: string } = {}, ctx: Context = BACKGROUND_CONTEXT): Promise<EventData> {
    const { branch } = options.branchId ? await this.branchRow(treeId, options.branchId) : { branch: await this.mainBranch(treeId) }
    if (options.key) {
      const found = await this.db.get<{ data: string }>('SELECT data FROM events WHERE idempotencyKey = ?', options.key)
      if (found) return JSON.parse(found.data) as EventData
    }
    let wake = draft.wake
    let body = draft.body
    if (wake) {
      const recent = await this.db.get<{ n: number }>('SELECT count(*) AS n FROM events WHERE branchId = ? AND wake = 1 AND createdAt > ?', branch.id, this.now() - 60_000)
      if (recent!.n >= WAKES_PER_MINUTE) {
        wake = false
        body += '\n\n（一分钟内的通知太多，这条没有立即处理，下次对话时再看。）'
      }
    }
    const event: EventData = { ...draft, body, wake, id: crypto.randomUUID(), createdAt: this.now() }
    const row: EventRow = { id: event.id, treeId, branchId: branch.id, data: JSON.stringify(event), wake: wake ? 1 : 0 }
    await this.db.run(
      'INSERT INTO events (id, treeId, branchId, data, wake, idempotencyKey, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      row.id,
      treeId,
      branch.id,
      row.data,
      row.wake,
      options.key ?? null,
      event.createdAt,
    )
    await this.deliver(row, ctx)
    return event
  }

  /** Places a stored Event in its branch: input that wakes it, or a write its next turn reads. */
  private async deliver(row: EventRow, ctx: Context) {
    const event = JSON.parse(row.data) as EventData
    const { tree, branch } = await this.branchRow(row.treeId, row.branchId)
    const conv = await this.open(branch, ctx)
    const text = eventText(event)
    const data = { ...event, source: { ...event.source } }
    if (row.wake) {
      await this.arm()
      const submission = await conv.submit({ type: 'input', content: [{ type: 'text', text }], requestId: `event:${event.id}`, entry: { kind: EVENT_KIND, data } }, ctx)
      await this.answered(tree, branch, conv, submission, '', ctx)
    } else {
      await conv.submit(
        { type: 'write', requestId: `event:${event.id}`, entry: { kind: EVENT_KIND, data, model: [{ role: 'user', content: [{ type: 'text', text }], timestamp: event.createdAt }] } },
        ctx,
      )
      await this.db.run('UPDATE trees SET updatedAt = ? WHERE id = ?', this.now(), tree.id)
      await this.changed()
    }
    await this.db.run('UPDATE events SET deliveredAt = ? WHERE id = ?', this.now(), event.id)
  }

  /** The `report` tool (R40): a user branch hands its result to the main branch, which reads it on its next turn. */
  async report(conversationId: number, report: { title: string; body: string }, ctx: Context) {
    const branch = await this.db.get<BranchRow>(`SELECT ${BRANCH_COLUMNS} FROM branches WHERE conversationId = ?`, conversationId)
    if (!branch) throw new Error('这个会话不在任何会话树里')
    if (branch.role === 'main') throw new Error('你已经在主线上，直接回答用户即可，不需要 report')
    // A subagent's report wakes the main line (R52); a user branch's waits for its next turn (R40).
    const agent = branch.role === 'agent'
    await this.emit(
      branch.treeId,
      { source: { kind: agent ? 'agent' : 'branch', id: branch.id, label: branch.title || '分叉' }, type: 'report', title: report.title, body: report.body, wake: agent },
      { key: `report:${conversationId}:${report.title}:${report.body.length}` },
      ctx,
    )
    if (!agent) return '已交给主线；用户回到主线时能看到，主线下一轮对话会读到它。'
    await this.db.run("UPDATE branches SET status = 'done' WHERE id = ?", branch.id)
    this.branchesChanged(branch.treeId)
    return '已汇报给主线，你的任务完成了；简短收尾即可，不要再做别的。'
  }

  // --- Subagents (R51–R56) ---

  /** Spawns run one at a time, so parallel calls of one turn count each other against the limit. */
  private spawning: Promise<unknown> = Promise.resolve()

  /** The `agent_spawn` tool (R51): a subagent branch with its brief, run in the background under an anchor task. */
  spawn(api: ToolExecutionApi, args: { task: string; title: string; mode: 'fork' | 'new' }, ctx: Context) {
    const run = this.spawning.then(() => this.spawnAgent(api, args, ctx))
    this.spawning = run.catch(() => {})
    return run
  }

  private async spawnAgent(api: ToolExecutionApi, { task, title, mode }: { task: string; title: string; mode: 'fork' | 'new' }, ctx: Context) {
    const from = await this.db.get<BranchRow>(`SELECT ${BRANCH_COLUMNS} FROM branches WHERE conversationId = ?`, api.conversationId)
    if (!from) throw new Error('这个会话不在任何会话树里')
    // Refused rather than hidden, so every branch keeps the same tool list and prompt prefix (R54, D3).
    if (from.role === 'agent') throw new Error('子 agent 不能再派生子 agent；请自己完成任务，然后用 report 汇报')
    if (from.role !== 'main') throw new Error('只有主线可以派出子 agent')
    if (!task.trim()) throw new Error('任务说明不能为空')
    const running = await this.db.get<{ n: number }>("SELECT count(*) AS n FROM branches WHERE treeId = ? AND role = 'agent' AND status = 'running'", from.treeId)
    if (running!.n >= MAX_AGENTS) throw new Error(`已有 ${MAX_AGENTS} 个子 agent 在运行（上限），等其中一个汇报后再派出`)

    const parent = await this.open(from, ctx)
    // A fork continues from the entry before this turn's answer: the conversation up to the request, without the
    // assistant message whose tool calls are still unanswered.
    const { items } = await parent.entries({}, PREVIEW_ENTRIES, undefined, ctx)
    const answer = items.findIndex((e) => e.kind === 'pi.assistant')
    const at = answer < 0 ? null : (items[answer + 1]?.id ?? null)
    const conv = mode === 'fork' && at !== null ? await parent.fork(at as EntryId, { ownership: { kind: 'ownerless' } }, ctx) : await this.emptyLike(from.treeId, parent, ctx)
    const branch: BranchRow = {
      id: crypto.randomUUID(),
      treeId: from.treeId,
      conversationId: conv.id,
      parentId: from.id,
      forkEntryId: at,
      role: 'agent',
      mode,
      title: titleOf(title.trim() || task.trim()),
      status: 'running',
      createdAt: this.now(),
    }
    await this.insertBranch(branch)
    const input: AgentInput = { treeId: from.treeId, branchId: branch.id, conversationId: conv.id, title: branch.title, task }
    // Background: the main line's Esc and idle waits do not reach the subagent (R51).
    await api.createTask(this.agentTask, input, { ownership: { kind: 'conversation' }, background: true }, ctx)
    this.branchesChanged(from.treeId)
    return `已派出子 agent「${branch.title}」。它完成后会用 report 汇报，汇报到达时会唤醒你。现在告诉用户你派出了什么，不要等待结果。`
  }

  /** Gives a subagent its brief and waits for that run to end. */
  async runAgent(input: AgentInput, ctx: Context): Promise<AgentEnd> {
    const conv = await this.harness.conversation(input.conversationId as ConversationId, ctx)
    if (!conv) return { status: 'unanswered', reason: 'gone' }
    await this.arm()
    const submission = await conv.submit(
      {
        type: 'input',
        content: [{ type: 'text', text: agentBrief(input.title, input.task) }],
        requestId: `agent:${input.branchId}`,
        entry: { kind: BRIEF_KIND, data: { label: `子 agent 任务：${input.task}` } },
      },
      ctx,
    )
    this.branchesChanged(input.treeId)
    const settled = await submission.wait(ctx)
    if (settled.status === 'done') return { status: 'done' }
    if (settled.reason !== 'aborted') {
      const data: RunErrorData = { reason: settled.reason, ...(settled.detail !== undefined && { detail: JSON.stringify(settled.detail) }) }
      await conv.submit({ type: 'write', requestId: `agent-error:${input.branchId}`, entry: { kind: RUN_ERROR_KIND, data: { ...data } } }, ctx)
    }
    return { status: 'unanswered', reason: settled.reason }
  }

  /** After a subagent's run: when it did not report, the system tells the main line for it (R53). */
  async finishAgent(input: AgentInput, end: AgentEnd, ctx: Context) {
    const branch = await this.db.get<BranchRow>(`SELECT ${BRANCH_COLUMNS} FROM branches WHERE id = ?`, input.branchId)
    // Reported already, or its tree is gone.
    if (!branch || branch.status !== 'running') return
    const aborted = end.status === 'unanswered' && end.reason === 'aborted'
    await this.db.run('UPDATE branches SET status = ? WHERE id = ?', aborted ? 'aborted' : 'failed', branch.id)
    const why = end.status === 'done' ? '它结束了，但没有调用 report 汇报' : aborted ? '它被中止了' : `它运行出错了（${end.reason}）`
    const conv = await this.harness.conversation(input.conversationId as ConversationId, ctx)
    const { items } = conv ? await conv.entries({}, PREVIEW_ENTRIES, undefined, ctx) : { items: [] }
    const last = items.find((e) => e.kind === 'pi.assistant' && entryText(e))
    await this.emit(
      input.treeId,
      {
        source: { kind: 'system', id: branch.id, label: '系统' },
        type: 'notice',
        title: `子 agent「${branch.title}」未完成`,
        body: `${why}。\n\n它的最后一条回答：\n\n${last ? entryText(last) : '（没有回答）'}`,
        wake: true,
      },
      { key: `agent-end:${branch.id}` },
      ctx,
    )
    this.branchesChanged(input.treeId)
  }

  /** "Summarize to the main line" (R40): asks a user branch to summarize itself and `report`. */
  async summarize(treeId: string, branchId: string, requestId: string, ctx: Context = BACKGROUND_CONTEXT) {
    const { tree, branch } = await this.branchRow(treeId, branchId)
    if (branch.role !== 'user') throw new Error('只有分叉可以总结给主线')
    await this.arm()
    const conv = await this.open(branch, ctx)
    const submission = await conv.submit(
      { type: 'input', content: [{ type: 'text', text: SUMMARIZE_PROMPT }], requestId, entry: { kind: BRIEF_KIND, data: { label: '总结给主线' } } },
      ctx,
    )
    await this.answered(tree, branch, conv, submission, '', ctx)
    return { branchId: branch.id, submissionId: submission.id }
  }

  // --- Schedules (R49) ---

  /** Called after any schedule or webhook changes. */
  subscribeAutomations(listener: () => void) {
    this.automationListeners.add(listener)
    return () => void this.automationListeners.delete(listener)
  }

  private automationsChanged() {
    if (!this.closed) for (const l of this.automationListeners) l()
  }

  async schedules(): Promise<ScheduleInfo[]> {
    return (await this.db.all<ScheduleRow>(`SELECT ${SCHEDULE_COLUMNS} FROM schedules ORDER BY createdAt`)).map(toSchedule)
  }

  private async scheduleRow(id: string) {
    const row = await this.db.get<ScheduleRow>(`SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE id = ?`, id)
    if (!row) throw new Error('定时任务不存在')
    return row
  }

  async createSchedule(treeId: string, input: { name: string; prompt: string; rule: ScheduleRule; tz: string }, ctx: Context = BACKGROUND_CONTEXT) {
    await this.row(treeId)
    const name = input.name.trim()
    const prompt = input.prompt.trim()
    if (!name || !prompt) throw new Error('名称和内容不能为空')
    checkRule(input.rule)
    checkTimeZone(input.tz)
    const row: ScheduleRow = {
      id: crypto.randomUUID(),
      treeId,
      name,
      prompt,
      rule: JSON.stringify(input.rule),
      tz: input.tz,
      enabled: 1,
      taskId: null,
      nextRunAt: null,
      lastRunAt: null,
      lastResult: '',
      createdAt: this.now(),
    }
    await this.db.run(
      `INSERT INTO schedules (${SCHEDULE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, '', ?)`,
      row.id,
      treeId,
      name,
      prompt,
      row.rule,
      row.tz,
      row.enabled,
      row.createdAt,
    )
    try {
      await this.startSchedule(row, ctx)
    } catch (e) {
      await this.db.run('DELETE FROM schedules WHERE id = ?', row.id)
      throw e
    }
    this.automationsChanged()
    return toSchedule(await this.scheduleRow(row.id))
  }

  /** A task for the schedule's next run, owned by the tree's main conversation. */
  private async startSchedule(row: ScheduleRow, ctx: Context) {
    const at = nextRun(JSON.parse(row.rule) as ScheduleRule, row.tz, this.now())
    if (at === null) throw new Error('执行时间已经过了')
    const conv = await this.open(await this.mainBranch(row.treeId), ctx)
    await this.arm()
    const taskId = await conv.commit(
      (tx) => tx.createTask(this.schedule, { scheduleId: row.id, at }, { ownership: { kind: 'conversation' }, background: true }),
      ctx,
    )
    await this.db.run('UPDATE schedules SET enabled = 1, taskId = ?, nextRunAt = ? WHERE id = ?', taskId, at, row.id)
    await this.options.arm?.(this.harness.wake())
  }

  private async stopSchedule(row: ScheduleRow, ctx: Context) {
    if (row.taskId !== null) await this.harness.abortTask(row.taskId as never, ctx).catch(() => {})
    await this.db.run('UPDATE schedules SET enabled = 0, taskId = NULL, nextRunAt = NULL WHERE id = ?', row.id)
  }

  /** Pauses or resumes a schedule; resuming starts from the next run after now. */
  async updateSchedule(id: string, enabled: boolean, ctx: Context = BACKGROUND_CONTEXT) {
    const row = await this.scheduleRow(id)
    if (enabled && row.enabled !== 1) await this.startSchedule(row, ctx)
    if (!enabled && row.enabled === 1) await this.stopSchedule(row, ctx)
    this.automationsChanged()
  }

  async deleteSchedule(id: string, ctx: Context = BACKGROUND_CONTEXT) {
    await this.stopSchedule(await this.scheduleRow(id), ctx)
    await this.db.run('DELETE FROM schedules WHERE id = ?', id)
    this.automationsChanged()
  }

  /** A schedule's run at `at`, from its task: an Event that wakes the main branch. Resolves to the next run. */
  async fireSchedule(id: string, at: number, ctx: Context): Promise<number | null> {
    const row = await this.db.get<ScheduleRow>(`SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE id = ?`, id)
    if (!row || row.enabled !== 1) return null
    let result = '已发送'
    try {
      await this.emit(row.treeId, { source: { kind: 'schedule', id, label: row.name }, type: 'tick', title: row.name, body: row.prompt, wake: true }, { key: `schedule:${id}:${at}` }, ctx)
    } catch (e) {
      result = `失败：${e instanceof Error ? e.message : String(e)}`
    }
    // Runs missed while the host was down are skipped, not made up.
    const next = nextRun(JSON.parse(row.rule) as ScheduleRule, row.tz, Math.max(at, this.now()))
    await this.db.run(
      'UPDATE schedules SET lastRunAt = ?, lastResult = ?, nextRunAt = ?, enabled = ?, taskId = ? WHERE id = ?',
      at,
      result,
      next,
      next === null ? 0 : 1,
      next === null ? null : row.taskId,
      id,
    )
    this.automationsChanged()
    return next
  }

  // --- Webhooks (R50) ---

  private webhookInfo = ({ secret: _, ...r }: WebhookRow): WebhookInfo => ({ ...r, path: `${this.options.hooksPath?.()}/${r.id}` })

  /** Webhook secrets are sealed, so creating one needs the host's TOKEN_ENCRYPTION_KEY. */
  get canCreateWebhooks() {
    return !!this.sealer
  }

  async webhooks(): Promise<WebhookInfo[]> {
    if (!this.options.hooksPath?.()) return []
    return (await this.db.all<WebhookRow>('SELECT id, treeId, secret, createdAt, lastUsedAt FROM webhooks ORDER BY createdAt')).map(this.webhookInfo)
  }

  /** A new webhook for the tree, replacing its old one. The secret is returned only now; it is stored sealed. */
  async createWebhook(treeId: string) {
    if (!this.options.hooksPath?.()) throw new Error('这个部署没有开启 Webhook')
    if (!this.sealer) throw new Error('服务器没有配置 TOKEN_ENCRYPTION_KEY，无法保存 Webhook 密钥')
    await this.row(treeId)
    const secret = `whsec_${[...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('')}`
    const row: WebhookRow = { id: crypto.randomUUID().replaceAll('-', ''), treeId, secret: await this.sealer.seal(secret), createdAt: this.now(), lastUsedAt: null }
    await this.db.run('DELETE FROM webhooks WHERE treeId = ?', treeId)
    await this.db.run('INSERT INTO webhooks (id, treeId, secret, createdAt, lastUsedAt) VALUES (?, ?, ?, ?, NULL)', row.id, treeId, row.secret, row.createdAt)
    this.automationsChanged()
    return { webhook: this.webhookInfo(row), secret }
  }

  async deleteWebhook(id: string) {
    await this.db.run('DELETE FROM webhooks WHERE id = ?', id)
    this.automationsChanged()
  }

  /**
   * A call to one of this user's webhooks: a signed POST becomes an Event that wakes the tree's main branch. Unsigned,
   * stale or wrongly signed calls get 401 and leave nothing behind.
   */
  async handleWebhook(hookId: string, request: Request, ctx: Context = BACKGROUND_CONTEXT): Promise<Response> {
    if (request.method !== 'POST') return json(405, { error: 'POST only' })
    const row = await this.db.get<WebhookRow>('SELECT id, treeId, secret, createdAt, lastUsedAt FROM webhooks WHERE id = ?', hookId)
    if (!row || !this.sealer) return json(404, { error: 'not found' })
    const body = await request.text()
    if (body.length > WEBHOOK_MAX_BODY) return json(413, { error: 'body too large' })
    const signature = request.headers.get('x-gense-signature')
    const valid = await verifySignature(await this.sealer.open(row.secret), request.headers.get('x-gense-timestamp'), signature, body, this.now())
    if (!valid) return json(401, { error: 'invalid signature' })
    const { title, body: text } = webhookContent(body, request.headers.get('content-type'))
    const event = await this.emit(
      row.treeId,
      { source: { kind: 'webhook', id: row.id, label: 'Webhook' }, type: 'webhook', title, body: text, wake: true },
      { key: `webhook:${row.id}:${request.headers.get('idempotency-key') ?? signature}` },
      ctx,
    )
    await this.db.run('UPDATE webhooks SET lastUsedAt = ? WHERE id = ?', this.now(), row.id)
    this.automationsChanged()
    return json(202, { eventId: event.id })
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
    this.automationListeners.clear()
    await this.harness.close(ctx)
  }
}
