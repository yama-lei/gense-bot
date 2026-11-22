import { pluginCatalog } from '../plugins/catalog.ts'
// One user's conversations: a pi-durable Harness plus the sidebar index, in the same SQLite database (roadmap-3 D2).
// A tree is a main conversation and the branches forked from it, all ownerless; tree and branch ids are ours,
// conversation ids are pi-durable's. Each tree has one workspace directory, every branch's cwd (D6).

import {
defineExtension,
section,
type EntryRecord,

type HarnessOptions
} from '@earendil-works/pi-durable'



import {
type BranchRole,
type BranchStatus,
type ScheduleInfo,
type ScheduleRule,
type TreeMeta
} from '@gense/protocol'

import { SKILLS_DIR,type EnvFactory } from './workspace.ts'







import { type PluginStoreOptions } from '../plugins/store.ts'

import type { ModelSetup } from './models.ts'

import { fileTools } from './ledger.ts'

import {
agentTask,
reportTool,
scheduleTask,
spawnTool
} from '../events/tasks.ts'

import { skillsSection } from '../plugins/skills.ts'



import type { UserSpace } from './space.ts'

export const DEFAULT_TITLE = '新对话'

export const TITLE_CHARS = 30

export const migrations = [
  {
    version: 1,
    statements: [
      'CREATE TABLE trees (id TEXT PRIMARY KEY, rootId INTEGER NOT NULL, title TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, source TEXT)',
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
      'CREATE TABLE schedules (id TEXT PRIMARY KEY, treeId TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL, rule TEXT NOT NULL, tz TEXT NOT NULL, enabled INTEGER NOT NULL, taskId INTEGER, nextRunAt INTEGER, lastRunAt INTEGER, lastResult TEXT NOT NULL, createdAt INTEGER NOT NULL)',
      'CREATE TABLE webhooks (id TEXT PRIMARY KEY, treeId TEXT NOT NULL, secret TEXT NOT NULL, createdAt INTEGER NOT NULL, lastUsedAt INTEGER)',
    ],
  },
  {
    version: 4,
    statements: [
      'CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, source TEXT NOT NULL, treeId TEXT, projectId TEXT, enabled INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)',
      'CREATE INDEX memories_updated ON memories (updatedAt DESC)',
    ],
  },
  {
    version: 5,
    statements: [
      'CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, color INTEGER NOT NULL, instructions TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)',
      'ALTER TABLE trees ADD COLUMN projectId TEXT',
      'CREATE INDEX trees_project ON trees (projectId)',
    ],
  },
  {
    version: 6,
    statements: [
      'ALTER TABLE trees ADD COLUMN expiresAt INTEGER',
      'CREATE INDEX trees_expiry ON trees (expiresAt) WHERE expiresAt IS NOT NULL',
    ],
  },
  {
    version: 7,
    statements: [
      'CREATE TABLE feedback (treeId TEXT NOT NULL, turnId TEXT NOT NULL, value TEXT NOT NULL, reasons TEXT NOT NULL, comment TEXT, model TEXT NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY (treeId, turnId))',
    ],
  },
  {
    version: 8,
    statements: ['CREATE TABLE inbox_read (id TEXT PRIMARY KEY, readAt INTEGER NOT NULL)'],
  },
  {
    version: 9,
    statements: ['CREATE TABLE exports (id TEXT PRIMARY KEY, status TEXT NOT NULL, size INTEGER, error TEXT, createdAt INTEGER NOT NULL, finishedAt INTEGER)'],
  },
  {
    // No more forks or tree map: a user branch is only a version of a message, and every tree opens on its main line.
    version: 10,
    statements: [
      "UPDATE branches SET role = 'version' WHERE role = 'user'",
      "UPDATE trees SET activeBranchId = (SELECT b.id FROM branches b WHERE b.treeId = trees.id AND b.role = 'main')",
    ],
  },
]

/** Who the assistant is and how it answers (roadmap-6 A10). Only the date changes, once a day, so the prompt cache holds. */
export function assistantPrompt(now: number, timeZone?: string) {
  const tz = timeZone || 'UTC'
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map((p) => [p.type, p.value]),
  )
  return [
    "You are Gense, the user's personal assistant. The user talks to you in a web app or a chat app such as Feishu; scheduled tasks, webhooks and subagents can also wake you with events.",
    `Today is ${parts.weekday}, ${parts.year}-${parts.month}-${parts.day} (${timeZone ? `the user's time zone, ${tz}` : 'UTC; the user\'s time zone is unknown'}). Use it for anything relative to now, and check facts that may have changed since your training instead of answering from memory.`,
    '',
    '# How to answer',
    '- Reply in the language the user writes in, unless they ask for another.',
    '- Lead with the answer. Match the length to the question: a simple question gets a sentence or two, not a report. No preamble ("Sure!") and no closing offers ("Let me know if…").',
    '- Format with Markdown where it helps reading, such as code blocks for code. No headings in short answers.',
    '- Be accurate. Say so when you are unsure or could not check something. Never invent facts, numbers, quotes, links or citations.',
    '- When the request is clear, do it. Ask one focused question only when a wrong guess would waste real effort or cannot be undone.',
    '- Before work that takes several tool calls, say in one sentence what you are about to do; do not narrate each step. When done, tell the user what you did and anything they should know, such as files you wrote or what you could not do.',
  ].join('\n')
}

/** pi's own text invites searching on every turn; ours says when it can find anything (A9). */
export const TOOL_SEARCH = [
  'Find tools that are not loaded yet, such as the tools of MCP servers the user connected, and load the matches for your next step.',
  '- The tools you can already see are loaded; search only when you need something none of them does, and an MCP plugin might.',
  '- Skills are not tools: they are listed in the skills section and read with `read`.',
  '- If nothing matches, the capability is not available; do the task another way or tell the user.',
].join('\n')

export const assistantExtension = (now: () => number, timeZone: () => string | undefined) =>
  defineExtension({ name: 'gense', sections: [section('assistant', () => assistantPrompt(now(), timeZone()))] })

export const PLUGINS = Object.fromEntries(pluginCatalog.map(p => [p.id, p.extension]))

export const files = defineExtension({
  name: 'files',
  tools: fileTools(),
  sections: [
    section('workspace', () =>
      [
        'This conversation has its own workspace directory, which is your current directory. All branches of this conversation tree share it, and the user can see and download its files in the file panel.',
        '- Save anything the user should keep (documents, data, code, results) as a file, and give its path in your reply.',
        '- Files the user attaches to a message are under `attachments/`.',
        '- Read a file before you change or delete it. If it changed after you read it, write/edit/delete fail: read it again, then retry.',
        `- \`${SKILLS_DIR}\` holds the shared Skills and is read-only.`,
        '- In a user message, `<command>` is a / command the user picked, and `<mentions>` lists plugins, files or other conversations the user referred to with @. Follow what they say.',
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
  models: ModelSetup | (() => ModelSetup)
  /** Host-only tenant identity and model metering, installed before work resumes. */
  userId?: string
  /** Public snapshot storage belongs to app.sqlite; direct standalone Harness tests need no public host. */
  shares?: import('../platform/shares.ts').ShareStore
  feedback?: (treeId: string, turnId: string, feedback: import('@gense/protocol').Feedback | null) => Promise<void>
  meterModels?: (models: import('@earendil-works/pi-ai').MutableModels, source: (provider: string) => import('@gense/protocol').ModelSource) => void
  deepseekService?: () => Promise<import('./deepseek-services.ts').DeepSeekService | undefined>
  serviceUsage?: (service: import('@gense/protocol').ServiceKind, units: number) => Promise<void>
  webUsage?: (service: 'search' | 'fetch') => Promise<void>
  /** Seals the user's plugin secrets and model credentials. */
  secretKey?: string
  /** The user's files (roadmap-3 D6): an environment for a virtual working directory under /data. */
  env: EnvFactory
  /** Plugin settings the host supplies, and the key that seals the user's plugin secrets. */
  plugins?: Pick<PluginStoreOptions, 'defaults'>
  /** Passed through to the Harness: wake scheduling and settings belong to the host. */
  harness?: Pick<HarnessOptions, 'onWake' | 'setTimer' | 'now' | 'settings' | 'onReport'>
  feishu?: import('../channels/feishu/index.ts').FeishuOptions
  channels?: import('../channels/channel.ts').ChannelDefinition[]
  outboxRetryMs?: number
  mcp?: import('../plugins/mcp/host.ts').McpOptions
  skillTempDir?: string
  now?: () => number
  /** The environment's `exec` runs in this user's sandbox, so the sandbox plugin and its `bash` are offered (D7). */
  sandbox?: boolean
  /** Whether the host serves webhooks at `HOOKS_PATH` (R50); without it there are none. */
  webhooks?: boolean
}

export type TreeRow = { id: string; rootId: number; title: string; pinned: number; createdAt: number; updatedAt: number; activeBranchId: string; source: string | null; projectId: string | null; expiresAt: number | null }

export const COLUMNS = 'id, rootId, title, pinned, createdAt, updatedAt, activeBranchId, source, projectId, expiresAt'

export const toMeta = ({ rootId: _, activeBranchId: __, source, projectId, expiresAt, ...r }: TreeRow): TreeMeta => ({ ...r, pinned: r.pinned === 1, ...(source && { source: JSON.parse(source) }), ...(projectId && { projectId }), ...(expiresAt !== null && { temporary: { expiresAt } }) })

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

export /** Newest entries searched for a branch's latest answer. */
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
            'A user message that contains `<event>` was not written by the user. It is a notification from a scheduled task, a webhook, a subagent or another branch. Act on what it says, and tell the user what you did about it, since they may not have seen the event.',
          ].join('\n'),
        ),
      ],
    }),
  }
}
