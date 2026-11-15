import { feishuDefinition } from '../channels/feishu/index.ts'
import type { ConversationWatch } from '@earendil-works/pi-durable'
import { ChannelHub } from '../channels/hub.ts'
import { TriggerStore } from '../events/store.ts'
import { Outbox } from '../events/outbox.ts'
import * as ingest from '../events/ingest.ts'
import { McpHost } from '../plugins/mcp/host.ts'
import { createToolSearchExtension } from '@earendil-works/pi-durable/tool-search'
import { defineExtension, section } from '@earendil-works/pi-durable'
import { PreferenceStore } from './preferences.ts'
import { FeedbackStore } from './feedback.ts'
import { SuggestionStore } from './suggestions.ts'
import { InboxReadStore } from './inbox.ts'
import { Library } from './library.ts'
import { MemoryStore, memoryExtension } from './memory.ts'
import { ProjectStore, projectExtension } from './projects.ts'
import type { UserShares } from '../platform/shares.ts'
import * as temporary from './temporary.ts'
// One user's conversations: a pi-durable Harness plus the sidebar index, in the same SQLite database (roadmap-3 D2).
// A tree is a main conversation and the branches forked from it, all ownerless; tree and branch ids are ours,
// conversation ids are pi-durable's. Each tree has one workspace directory, every branch's cwd (D6).
import { BACKGROUND_CONTEXT,type Context } from '@earendil-works/chord/context'

import { applySqliteMigrations,type SqliteDatabase } from '@earendil-works/chord/sqlite'

import {
createRegistry,
Harness,
type Extension
} from '@earendil-works/pi-durable'

import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite'

import {
type TreeMeta,
type WebhookInfo
} from '@gense/protocol'

import { DATA_DIR,Workspace } from './workspace.ts'

import { noSandbox } from '../plugins/sandbox.ts'

import { PluginStore,Sealer } from '../plugins/store.ts'

import { ModelAccounts } from './credentials.ts'

import {
HOOKS_PATH
} from '../events/tasks.ts'

import { SkillStore } from '../plugins/skills.ts'

import * as branches from './branches.ts'
import * as events from './events.ts'
import * as schedules from './schedules.ts'
import { TOOL_SEARCH, eventsExtension,assistantExtension,files,migrations,PLUGINS,type SpaceOptions,type WebhookRow } from './shared.ts'
import * as subagents from './subagents.ts'
import * as trees from './trees.ts'
import * as webhooks from './webhooks.ts'
import { compact, compactionPolicy, compactionRegistry } from './compaction.ts'
import { deepseekRegistry, initializeDeepseek } from './deepseek.ts'
import { initializeAttachments } from './attachments.ts'
import { webExtension } from '../plugins/web.ts'
export type { SpaceOptions } from './shared.ts'
export class UserSpace {

  readonly listeners = new Set<(trees: TreeMeta[]) => void>()

  readonly branchListeners = new Set<(treeId: string) => void>()

  readonly automationListeners = new Set<() => void>()

  /** Whether each conversation last ran, from its `pi.live` commits; a change updates its tree's branches. */
  readonly running = new Map<number, boolean>()

  readonly db: SqliteDatabase

  readonly harness: Harness

  readonly workspace: Workspace

  readonly plugins: PluginStore

  readonly skills: SkillStore

  readonly channels: ChannelHub
  readonly triggers: TriggerStore
  readonly outbox: Outbox
  readonly ingestQueues = new Map<string, Promise<unknown>>()
  readonly channelRuns = new Map<string, Promise<void>>()
  readonly channelWatches = new Set<ConversationWatch>()
  readonly mcp: McpHost
  readonly preferences: PreferenceStore
  readonly feedback: FeedbackStore
  readonly suggestions: SuggestionStore
  readonly inboxRead: InboxReadStore
  readonly library: Library
  readonly memories: MemoryStore
  readonly projects: ProjectStore
  readonly shares: UserShares | undefined
  readonly accounts: ModelAccounts

  readonly options: SpaceOptions
  temporaryTimer: ReturnType<typeof setInterval> | undefined
  temporaryCleanup: Promise<void> | undefined

  readonly sealer: Sealer | undefined

  /** Set once in `open`, before the Harness resumes work. */
  schedule!: ReturnType<typeof eventsExtension>['schedule']

  agentTask!: ReturnType<typeof eventsExtension>['agent']

  constructor(db: SqliteDatabase, harness: Harness, workspace: Workspace, plugins: PluginStore, skills: SkillStore, accounts: ModelAccounts, options: SpaceOptions, preferences: PreferenceStore, mcp: McpHost, channels: ChannelHub, triggers: TriggerStore, outbox: Outbox) {
    this.sealer = options.secretKey ? new Sealer(options.secretKey) : undefined
    this.db = db
    this.harness = harness
    this.workspace = workspace
    this.plugins = plugins
    this.skills = skills
    this.channels = channels
    this.triggers = triggers
    this.outbox = outbox
    this.mcp = mcp
    this.preferences = preferences
    this.feedback = new FeedbackStore(this)
    this.suggestions = new SuggestionStore(this)
    this.inboxRead = new InboxReadStore(db, () => this.now())
    this.memories = new MemoryStore(db, () => this.now())
    this.projects = new ProjectStore(this)
    this.library = new Library(this)
    this.accounts = accounts
    this.options = options
    if (options.shares && !options.userId) throw new Error('分享存储需要用户 id')
    this.shares = options.shares?.forUser(options.userId!, id => this.row(id), () => this.now())
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
    await initializeDeepseek(db)
    await initializeAttachments(db)
    const triggers = await TriggerStore.open(db)
    const channels = await ChannelHub.open(db, options.secretKey)
    const outbox = new Outbox(db, item => channels.deliver(item), options.outboxRetryMs)
    const storage = await SqliteStorage.open(db, { prefix: 'pi_' })
    const plugins = await PluginStore.open(db, { ...options.plugins, secretKey: options.secretKey, available: Object.keys(PLUGINS).filter((id) => id !== 'sandbox' || options.sandbox) })
    const preferences = await PreferenceStore.open(db)
    const prefsExtension = defineExtension({ name: 'preferences', sections: [section('preferences', () => preferences.prompt())] })
    const gense = assistantExtension(options.now ?? Date.now, () => preferences.get().timeZone)
    const base = createToolSearchExtension()
    const toolSearch = { ...base, tools: base.tools?.map((t) => (t.name === 'tool_search' ? { ...t, description: TOOL_SEARCH } : t)) }
    const registry = createRegistry()
    const byName = new Map<string, Extension>()
    let space: UserSpace | undefined
    const getSpace = () => {
      if (!space) throw new Error('UserSpace is not open')
      return space
    }
    const events = eventsExtension(getSpace)
    const memory = memoryExtension(getSpace)
    const explicitMemory = memoryExtension(getSpace, 'explicit')
    const project = projectExtension(getSpace)
    for (const e of [gense, files, prefsExtension, toolSearch, events.extension, memory, explicitMemory, project, noSandbox, ...Object.entries(PLUGINS).map(([id, make]) => id === 'web' ? webExtension(() => plugins.resolved(id), service => options.webUsage?.(service) ?? Promise.resolve()) : make(() => plugins.resolved(id)))]) {
      registry.install(e)
      byName.set(e.name, e)
    }
    const refreshPlugins = () => {
      const hidden = new Set(plugins.removedTools())
      for (const { id, extension: make } of plugins.definitions()) {
        const extension = id === 'web' ? webExtension(() => plugins.resolved(id), service => options.webUsage?.(service) ?? Promise.resolve()) : make(() => plugins.resolved(id))
        const filtered = { ...extension, tools: extension.tools?.filter(t => !hidden.has(t.name)) }
        registry.install(filtered)
        byName.set(id, filtered)
      }
    }
    refreshPlugins()
    plugins.subscribe(refreshPlugins)
    const mcp = await McpHost.open(db, plugins, options.secretKey, options.mcp)
    const accounts = await ModelAccounts.open(db, { host: options.models, secretKey: options.secretKey, oauth: true })
    options.meterModels?.(accounts.models, provider => accounts.source(provider))
    const workspace = new Workspace(options.env, async treeId => (await db.get<{ projectId: string | null }>('SELECT projectId FROM trees WHERE id = ?', treeId))?.projectId ?? null)
    const skills = await SkillStore.open(db, async () => workspace.env(DATA_DIR), ctx, options.skillTempDir)
    // Conversations follow the host's selection, read at every resolution: a plugin switched on or off applies from the
    // next turn of every conversation (D8). Every branch of a tree gets the same selection, so forks share its prefix (D3).
    const settings = () => {
      const supplied = typeof options.harness?.settings === 'function' ? options.harness.settings() : options.harness?.settings
      const { modelOverrides = {}, ...policy } = supplied?.compaction ?? {}
      const active = plugins.active()
      return {
        ...supplied,
        compaction: {
          ...policy,
          modelOverrides: {
            ...modelOverrides,
            ...Object.fromEntries(accounts.models.getModels().map(model => [
              `${model.provider}/${model.id}`,
              { ...compactionPolicy(model.contextWindow), ...policy, ...modelOverrides[`${model.provider}/${model.id}`] },
            ])),
          },
        },
        extensions: [gense, files, prefsExtension, toolSearch, events.extension, ...active.map((id) => byName.get(id)!), ...(active.includes('sandbox') ? [] : [noSandbox]), ...(preferences.get().useMemory === false ? [] : [preferences.get().memoryWrites === 'explicit' ? explicitMemory : memory]), project],
      }
    }
    const harness = await Harness.open(
      storage,
      { ...options.harness, settings, models: accounts.models, registry: deepseekRegistry(compactionRegistry(registry), getSpace), env: ({ cwd }) => workspace.agentEnv(cwd ?? DATA_DIR) },
      ctx,
    )
    space = new UserSpace(db, harness, workspace, plugins, skills, accounts, options, preferences, mcp, channels, triggers, outbox)
    space.schedule = events.schedule
    space.agentTask = events.agent
    await space.cleanupTemporary()
    channels.register(feishuDefinition(space, options.feishu))
    for (const definition of options.channels ?? []) channels.register(definition)
    await channels.start(trigger => space!.ingestChannel(trigger))
    await space.recoverTriggers()
    outbox.start()
    // Continue runs a previous process left unfinished (R32).
    harness.resume()
    space.startTemporaryCleanup()
    return space
  }

  // --- Subagents (R51–R56) ---

  /** Spawns run one at a time, so parallel calls of one turn count each other against the limit. */
  spawning: Promise<unknown> = Promise.resolve()

  // --- Webhooks (R50) ---

  webhookInfo = ({ secret: _, ...r }: WebhookRow): WebhookInfo => ({ ...r, path: `${HOOKS_PATH}${this.options.userId ? `/${this.options.userId}` : ''}/${r.id}` })

  /** Webhook secrets are sealed, so creating one needs the host's TOKEN_ENCRYPTION_KEY. */
  get canCreateWebhooks() {
    return !!this.sealer
  }

  get shareLinks() {
    if (!this.shares) throw new Error('这个部署没有开启公开分享')
    return this.shares
  }

  closed = false
  now: OmitThisParameter<typeof trees.now> = trees.now.bind(this)
  searchTrees: OmitThisParameter<typeof trees.searchTrees> = trees.searchTrees.bind(this)
  trees: OmitThisParameter<typeof trees.trees> = trees.trees.bind(this)
  subscribeTrees: OmitThisParameter<typeof trees.subscribeTrees> = trees.subscribeTrees.bind(this)
  subscribeBranches: OmitThisParameter<typeof trees.subscribeBranches> = trees.subscribeBranches.bind(this)
  changed: OmitThisParameter<typeof trees.changed> = trees.changed.bind(this)
  branchesChanged: OmitThisParameter<typeof trees.branchesChanged> = trees.branchesChanged.bind(this)
  conversationChanged: OmitThisParameter<typeof trees.conversationChanged> = trees.conversationChanged.bind(this)
  createTree: OmitThisParameter<typeof trees.createTree> = trees.createTree.bind(this)
  insertBranch: OmitThisParameter<typeof trees.insertBranch> = trees.insertBranch.bind(this)
  updateTree: OmitThisParameter<typeof trees.updateTree> = trees.updateTree.bind(this)
  deleteTree: OmitThisParameter<typeof trees.deleteTree> = trees.deleteTree.bind(this)
  row: OmitThisParameter<typeof trees.row> = trees.row.bind(this)
  branchRow: OmitThisParameter<typeof trees.branchRow> = trees.branchRow.bind(this)
  open: OmitThisParameter<typeof trees.open> = trees.open.bind(this)
  files: OmitThisParameter<typeof trees.files> = trees.files.bind(this)
  callTool: OmitThisParameter<typeof trees.callTool> = trees.callTool.bind(this)
  branches: OmitThisParameter<typeof branches.branches> = branches.branches.bind(this)
  branchMeta: OmitThisParameter<typeof branches.branchMeta> = branches.branchMeta.bind(this)
  versions: OmitThisParameter<typeof branches.versions> = branches.versions.bind(this)
  continuing: OmitThisParameter<typeof branches.continuing> = branches.continuing.bind(this)
  addBranch: OmitThisParameter<typeof branches.addBranch> = branches.addBranch.bind(this)
  emptyLike: OmitThisParameter<typeof branches.emptyLike> = branches.emptyLike.bind(this)
  fork: OmitThisParameter<typeof branches.fork> = branches.fork.bind(this)
  userEntry: OmitThisParameter<typeof branches.userEntry> = branches.userEntry.bind(this)
  regenerate: OmitThisParameter<typeof branches.regenerate> = branches.regenerate.bind(this)
  checkModel: OmitThisParameter<typeof branches.checkModel> = branches.checkModel.bind(this)
  sendInput: OmitThisParameter<typeof branches.send> = branches.send.bind(this)
  send: OmitThisParameter<typeof ingest.webSend> = ingest.webSend.bind(this)
  ingestChannel: OmitThisParameter<typeof ingest.ingestChannel> = ingest.ingestChannel.bind(this)
  processChannel: OmitThisParameter<typeof ingest.processChannel> = ingest.processChannel.bind(this)
  monitorChannel: OmitThisParameter<typeof ingest.monitorChannel> = ingest.monitorChannel.bind(this)
  recoverTriggers: OmitThisParameter<typeof ingest.recoverTriggers> = ingest.recoverTriggers.bind(this)
  submit: OmitThisParameter<typeof branches.submit> = branches.submit.bind(this)
  answered: OmitThisParameter<typeof branches.answered> = branches.answered.bind(this)
  mentioned: OmitThisParameter<typeof branches.mentioned> = branches.mentioned.bind(this)
  transcript: OmitThisParameter<typeof branches.transcript> = branches.transcript.bind(this)
  mainBranch: OmitThisParameter<typeof events.mainBranch> = events.mainBranch.bind(this)
  emit: OmitThisParameter<typeof events.emit> = events.emit.bind(this)
  deliver: OmitThisParameter<typeof events.deliver> = events.deliver.bind(this)
  report: OmitThisParameter<typeof events.report> = events.report.bind(this)
  spawn: OmitThisParameter<typeof subagents.spawn> = subagents.spawn.bind(this)
  spawnAgent: OmitThisParameter<typeof subagents.spawnAgent> = subagents.spawnAgent.bind(this)
  runAgent: OmitThisParameter<typeof subagents.runAgent> = subagents.runAgent.bind(this)
  finishAgent: OmitThisParameter<typeof subagents.finishAgent> = subagents.finishAgent.bind(this)
  summarize: OmitThisParameter<typeof subagents.summarize> = subagents.summarize.bind(this)
  subscribeAutomations: OmitThisParameter<typeof schedules.subscribeAutomations> = schedules.subscribeAutomations.bind(this)
  automationsChanged: OmitThisParameter<typeof schedules.automationsChanged> = schedules.automationsChanged.bind(this)
  schedules: OmitThisParameter<typeof schedules.schedules> = schedules.schedules.bind(this)
  scheduleRow: OmitThisParameter<typeof schedules.scheduleRow> = schedules.scheduleRow.bind(this)
  createSchedule: OmitThisParameter<typeof schedules.createSchedule> = schedules.createSchedule.bind(this)
  startSchedule: OmitThisParameter<typeof schedules.startSchedule> = schedules.startSchedule.bind(this)
  stopSchedule: OmitThisParameter<typeof schedules.stopSchedule> = schedules.stopSchedule.bind(this)
  updateSchedule: OmitThisParameter<typeof schedules.updateSchedule> = schedules.updateSchedule.bind(this)
  deleteSchedule: OmitThisParameter<typeof schedules.deleteSchedule> = schedules.deleteSchedule.bind(this)
  fireSchedule: OmitThisParameter<typeof schedules.fireSchedule> = schedules.fireSchedule.bind(this)
  webhooks: OmitThisParameter<typeof webhooks.webhooks> = webhooks.webhooks.bind(this)
  createWebhook: OmitThisParameter<typeof webhooks.createWebhook> = webhooks.createWebhook.bind(this)
  deleteWebhook: OmitThisParameter<typeof webhooks.deleteWebhook> = webhooks.deleteWebhook.bind(this)
  handleWebhook: OmitThisParameter<typeof webhooks.handleWebhook> = webhooks.handleWebhook.bind(this)
  abort: OmitThisParameter<typeof trees.abort> = trees.abort.bind(this)
  compact = compact.bind(this)
  watch: OmitThisParameter<typeof trees.watch> = trees.watch.bind(this)
  close: OmitThisParameter<typeof trees.close> = trees.close.bind(this)
  cleanupTemporary = temporary.cleanupTemporary.bind(this)
  startTemporaryCleanup = temporary.startTemporaryCleanup.bind(this)
  stopTemporaryCleanup = temporary.stopTemporaryCleanup.bind(this)
}
