// One user's conversations: a pi-durable Harness plus the sidebar index, in the same SQLite database (roadmap-3 D2).
// A tree is a main conversation and the branches forked from it, all ownerless; tree and branch ids are ours,
// conversation ids are pi-durable's. Each tree has one workspace directory, every branch's cwd (D6).

import {
defineExtension,
section,
type EntryRecord,
type Extension,
type HarnessOptions
} from '@earendil-works/pi-durable'

import type { PluginValue } from '../plugins/catalog.ts'

import {
type BranchRole,
type BranchStatus,
type ScheduleInfo,
type ScheduleRule,
type TreeMeta
} from '@gense/protocol'

import { SKILLS_DIR,type EnvFactory } from './workspace.ts'

import { artifactExtension,emailExtension,uiExtension } from '../plugins/display.ts'

import { imageExtension } from '../plugins/image.ts'

import { sandboxExtension } from '../plugins/sandbox.ts'

import { type PluginStoreOptions } from '../plugins/store.ts'

import type { ModelSetup } from './models.ts'

import { fileTools } from './ledger.ts'

import {
agentTask,
MAX_AGENTS,
reportTool,
scheduleTask,
spawnTool
} from '../events/tasks.ts'

import { skillsSection } from '../plugins/skills.ts'

import { webExtension } from '../plugins/web.ts'

import type { UserSpace } from './space.ts'

export const DEFAULT_TITLE = '新对话'

export const TITLE_CHARS = 30

export const migrations = [
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

export const PREAMBLE = [
  '你是 gense，用户的个人助理。',
  '用用户使用的语言回答，简洁、准确；不确定时直接说明。',
].join('\n')

export const gense = defineExtension({ name: 'gense', sections: [section('assistant', () => PREAMBLE)] })

export /** Plugins this core implements, by catalog id; each extension reads its user's settings when a tool runs. */
const PLUGINS: Record<string, (config: () => Record<string, PluginValue>) => Extension> = {
  artifact: artifactExtension,
  email: emailExtension,
  ui: uiExtension,
  web: webExtension,
  image: imageExtension,
  sandbox: sandboxExtension,
}

export const files = defineExtension({
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

export /** Events that may wake one branch in a minute; more only land in its transcript (R47). */
const WAKES_PER_MINUTE = 6

export /** How much of a mentioned conversation goes into the message: its latest text. */
const MENTIONED_CHAT_CHARS = 20_000

export interface SpaceOptions {
  /** The host's providers; each user adds their own with `accounts` (R62). */
  models: ModelSetup
  /** Seals the user's plugin secrets and model credentials. */
  secretKey?: string
  /** The user's files (roadmap-3 D6): an environment for a virtual working directory under /data. */
  env: EnvFactory
  /** Plugin settings the host supplies, and the key that seals the user's plugin secrets. */
  plugins?: Pick<PluginStoreOptions, 'defaults'>
  /** Passed through to the Harness: wake scheduling and settings belong to the host. */
  harness?: Pick<HarnessOptions, 'onWake' | 'setTimer' | 'now' | 'settings' | 'onReport'>
  now?: () => number
  /** The environment's `exec` runs in this user's sandbox, so the sandbox plugin and its `bash` are offered (D7). */
  sandbox?: boolean
  /** Whether the host serves webhooks at `HOOKS_PATH` (R50); without it there are none. */
  webhooks?: boolean
}

export type TreeRow = { id: string; rootId: number; title: string; pinned: number; createdAt: number; updatedAt: number; activeBranchId: string }

export const COLUMNS = 'id, rootId, title, pinned, createdAt, updatedAt, activeBranchId'

export const toMeta = ({ rootId: _, activeBranchId: __, ...r }: TreeRow): TreeMeta => ({ ...r, pinned: r.pinned === 1 })

export type BranchRow = {
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

export const BRANCH_COLUMNS = 'id, treeId, conversationId, parentId, forkEntryId, role, mode, title, status, createdAt'

export /** How much of a branch's newest answer the tree map shows. */
const PREVIEW_CHARS = 160

export /** Newest entries searched for that answer. */
const PREVIEW_ENTRIES = 20

export const entryText = (e: EntryRecord) =>
  (e.model ?? [])
    .flatMap((m) => (typeof m.content === 'string' ? [m.content] : m.content.flatMap((b) => (b.type === 'text' ? [b.text] : []))))
    .join('')
    .trim()

export const titleOf = (named: string) => named.replace(/\s+/g, ' ').slice(0, TITLE_CHARS)

export type ScheduleRow = Omit<ScheduleInfo, 'rule' | 'enabled'> & { rule: string; enabled: number; taskId: number | null }

export const SCHEDULE_COLUMNS = 'id, treeId, name, prompt, rule, tz, enabled, taskId, nextRunAt, lastRunAt, lastResult, createdAt'

export const toSchedule = ({ rule, enabled, taskId: _, ...r }: ScheduleRow): ScheduleInfo => ({ ...r, rule: JSON.parse(rule) as ScheduleRule, enabled: enabled === 1 })

export type WebhookRow = { id: string; treeId: string; secret: string; createdAt: number; lastUsedAt: number | null }

export type EventRow = { id: string; treeId: string; branchId: string; data: string; wake: number }

export /** The tasks and tools of events, bound to their space once it exists. */
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