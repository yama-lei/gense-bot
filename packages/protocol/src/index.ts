// The contract between the web client and the server (roadmap-5): messages over one WebSocket, plus
//   POST /api/register, /api/login { email, password }, POST /api/logout, GET /api/me            the session cookie
//   POST /api/password { current, next }                                   signs every other session out
//   GET  /api/mcp/callback                                                 where an MCP server's OAuth returns
// Types and constants only: the browser imports it too.
import type { WireOp } from '@earendil-works/chord/delta'
import type { AuthEvent, AuthType } from '@earendil-works/pi-ai'
import type { CommandNote, Mention } from './notes.ts'
import type { ChannelInfo, PluginInfo, PluginValue, SkillInfo, SkillSource } from './plugins.ts'

export * from './accounts.ts'
export * from './notes.ts'
export * from './plugins.ts'
export * from './discover.ts'
export * from './memory.ts'
export * from './share.ts'
export * from './activity.ts'
export * from './deepseek.ts'

import type { Memory, MemorySource, Project } from './memory.ts'
import type { ShareInfo, ShareSnapshot } from './share.ts'
import type { NativeTrace } from './deepseek.ts'
import type { ExportInfo, Feedback, FeedbackReason, FileKind, Suggestions } from './activity.ts'

/**
 * A conversation as the sidebar lists it, titled by its main branch. Internally a tree of branches: the main one,
 * versions of a message (retry, edit) and subagents; the user sees only the main line and `‹ 2/3 ›` versions.
 */
export interface TreeMeta {
  id: string
  title: string
  pinned: boolean
  /** The channel it started in, when not the web: `feishu` and the chat's name. */
  source?: { kind: string; label: string }
  /** The project it belongs to (roadmap-7 A7); a conversation is in at most one. */
  projectId?: string
  /**
   * A temporary chat (roadmap-7 B5): listed only so the client can open it; the web hides it everywhere else. The
   * server leaves it out of search, gives it no memory, refuses to share, schedule or move it, and deletes it with its
   * workspace at `expiresAt` (B6).
   */
  temporary?: { expiresAt: number }
  createdAt: number
  updatedAt: number
}

/** A conversation a search found; `snippet` is the text around the match. */
export interface TreeHit {
  treeId: string
  title: string
  snippet: string
  updatedAt: number
}

/** What the owner tells the assistant about themselves and how to answer; part of every conversation's prompt. */
export interface Preferences {
  name: string
  instructions: string
  /** IANA time zone, e.g. Asia/Shanghai; the web client keeps it in step with the browser. */
  timeZone?: string
  /** Send enabled memories to the model, and offer it the `memory` tool (A2). Default true. */
  useMemory?: boolean
  /** `explicit`: the model writes memories only when the user asks it to (Q1). Default `auto`. */
  memoryWrites?: 'auto' | 'explicit'
  /** Follow-up suggestions after each answer (roadmap-7 D2). Default true. */
  suggestions?: boolean
  /**
   * DeepSeek's safety check for the user's own DeepSeek key (Q6). Default true; shared DeepSeek providers always
   * check, whatever this says.
   */
  deepseekSafety?: boolean
}

/** `version`: another version of one of the main line's messages, from a retry or an edit. `agent`: a subagent. */
export type BranchRole = 'main' | 'version' | 'agent'
export type BranchStatus = 'idle' | 'running' | 'done' | 'failed' | 'aborted'

/** One conversation of a tree (roadmap-3 D2). Entry ids are global, so they order versions across branches. */
export interface BranchMeta {
  id: string
  /** pi-durable conversation id; view entries carry it, so a client tells which branch wrote an entry. */
  conversationId: number
  /** Entry of the parent's transcript it continues from; null when it starts empty (a version of the first message). */
  forkEntryId: number | null
  role: BranchRole
  /** Its first message; empty while it has none. */
  title: string
  status: BranchStatus
  createdAt: number
}

export interface BranchesState {
  branches: BranchMeta[]
  /** Where the user last was; a watch without a branch opens it. */
  activeBranchId: string
  /**
   * Versions of a message (R37): branches that continue the same entry with a message of their own, oldest first.
   * Keyed by that entry's id, or `start` for the first message.
   */
  versions: Record<string, string[]>
}

export interface ModelInfo {
  /** Shared by the admin, or authenticated with this user’s credentials. */
  source?: import('./accounts.ts').ModelSource
  provider: string
  /** The provider's display name when it differs from its id (a shared provider is `shared-<uuid>`). */
  providerName?: string
  id: string
  name: string
}

export type Effort = 'low' | 'medium' | 'high'

/** A model service the user can sign in to with their own credentials (R62). */
export interface ProviderState {
  id: string
  name: string
  /** What the API-key login asks for, e.g. "Anthropic API key"; null when there is none. */
  apiKey: string | null
  /** The subscription login's label; null when there is none or the host cannot run it. */
  oauth: string | null
  /** How the user is signed in; null when they are not. */
  configured: AuthType | null
}

/** A question a login asks the user; `select` answers with an option id. */
export type LoginPrompt =
  | { type: 'text' | 'secret' | 'manual_code'; message: string; placeholder?: string }
  | { type: 'select'; message: string; options: { id: string; label: string; description?: string }[] }

/** A file in a tree's workspace or the Skills, for the file panel. Paths are the agent's (`/data/...`). */
export interface FileEntry {
  path: string
  size: number
  mtime: number
  /** Under the read-only Skills. */
  readOnly: boolean
}

export interface FilePreview {
  text: string
  size: number
  /** Only the start of the file is in `text`. */
  truncated: boolean
  /** Not UTF-8 text; `text` is empty. */
  binary: boolean
}

/** An uploaded file; `id` is its path under /data/uploads. */
export interface UploadedFile {
  id: string
  name: string
  mimeType: string
  size: number
  modifiedTime: number
}

/** A tool's result as a view sees it (MCP `CallToolResult`). */
export interface ToolCallResult {
  content: string
  structuredContent?: unknown
  isError?: boolean
}

/** Kind of an entry the app places for a message that is not the user's own input (roadmap-3 D4); data is EventData. */
export const EVENT_KIND = 'app.event'
/** Kind of an input the app asks the model on the user's behalf, such as a subagent's task (D3); data is BriefData. */
export const BRIEF_KIND = 'app.brief'

/** An Event as its card shows it (R46): where it came from, a title and a body. */
export interface EventData {
  id: string
  source: { kind: 'agent' | 'schedule' | 'webhook' | 'system' | 'channel'; id: string; label: string }
  type: 'report' | 'tick' | 'webhook' | 'notice'
  title: string
  body: string
  /** Whether it started a run; false only lands in the transcript for the next turn (R47). */
  wake: boolean
  createdAt: number
}

export interface BriefData {
  label: string
}

/** When a schedule fires (R49), as wall-clock times in the schedule's time zone. Days are 0 (Sunday) to 6. */
export type ScheduleRule =
  | { kind: 'once'; at: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; days: number[]; time: string }
  | { kind: 'interval'; minutes: number }

export interface ScheduleInfo {
  id: string
  treeId: string
  name: string
  /** What the conversation is asked when it fires. */
  prompt: string
  rule: ScheduleRule
  /** IANA time zone the rule's times are in. */
  tz: string
  enabled: boolean
  nextRunAt: number | null
  lastRunAt: number | null
  lastResult: string
  createdAt: number
}

/** A conversation's webhook (R50); POST to `path` on the host, signed with its secret. */
export interface WebhookInfo {
  id: string
  treeId: string
  path: string
  createdAt: number
  lastUsedAt: number | null
}

/** Requests carry an `id`; the host answers each with one `reply`. */
export type ClientRequest =
  /** Resolves to the new TreeMeta; with `projectId` it starts in that project; `temporary` cannot be in a project. */
  | { t: 'tree.create'; id: number; projectId?: string; temporary?: boolean }
  /** `projectId: null` takes it out of its project. */
  | { t: 'tree.update'; id: number; treeId: string; title?: string; pinned?: boolean; projectId?: string | null }
  | { t: 'tree.delete'; id: number; treeId: string }
  /** Resolves to the ShareInfo of a new link to this snapshot of `treeId` (B1); refused for a temporary chat. */
  | { t: 'share.create'; id: number; treeId: string; snapshot: ShareSnapshot }
  /** Replaces the snapshot behind an existing link; the link stays the same (B3, Q4). */
  | { t: 'share.update'; id: number; token: string; snapshot: ShareSnapshot }
  /** Stops sharing: the link answers 404 from now on. */
  | { t: 'share.delete'; id: number; token: string }
  /** Conversations whose title or messages match; resolves to TreeHit[], best first. */
  | { t: 'trees.search'; id: number; query: string; limit?: number }
  | { t: 'prefs.set'; id: number; name?: string; instructions?: string; timeZone?: string; useMemory?: boolean; memoryWrites?: 'auto' | 'explicit'; suggestions?: boolean; deepseekSafety?: boolean }
  /** Resolves to the new Memory. `source` defaults to `manual`; `saved` keeps an answer of `treeId`; `model` restores an entry the model wrote (undo). */
  | { t: 'memory.add'; id: number; text: string; source?: MemorySource; treeId?: string; projectId?: string | null; enabled?: boolean }
  /** Resolves to the changed Memory. */
  | { t: 'memory.update'; id: number; memoryId: string; text?: string; enabled?: boolean; projectId?: string | null }
  | { t: 'memory.remove'; id: number; memoryId: string }
  /** Resolves to the new Project. */
  | { t: 'project.create'; id: number; name: string; instructions?: string; color?: number }
  | { t: 'project.update'; id: number; projectId: string; name?: string; instructions?: string; color?: number }
  /** Deletes its files and its memories; its conversations are deleted with `deleteChats`, otherwise moved out. */
  | { t: 'project.delete'; id: number; projectId: string; deleteChats: boolean }
  /** Resolves to FileEntry[] with paths under projectDir(projectId). */
  | { t: 'project.files.list'; id: number; projectId: string }
  /** Moves uploads (ids from `upload`) into the project; resolves to FileEntry[]. Fails past PROJECT_LIMITS.files. */
  | { t: 'project.files.add'; id: number; projectId: string; uploads: string[] }
  | { t: 'project.files.delete'; id: number; projectId: string; path: string }
  /** Resolves to `{ name, mimeType, base64 }`. */
  | { t: 'project.files.read'; id: number; projectId: string; path: string }
  /**
   * `attachments` are upload ids; they are copied into the tree's workspace. Goes to `branchId`, or the active branch.
   * With `replace` (a user entry id) the message is an edit: it goes to a new branch beside that message (R37).
   * Resolves to `{ branchId }`.
   */
  | {
      t: 'send'
      id: number
      treeId: string
      branchId?: string
      replace?: number
      text: string
      requestId: string
      model?: ModelInfo
      effort?: Effort
      attachments?: string[]
      command?: CommandNote
      mentions?: Mention[]
    }
  | { t: 'abort'; id: number; treeId: string; branchId?: string }
  /**
   * Starts manual context compaction on this branch (or the active one); resolves to `{ taskId, branchId }` once
   * admitted, or with `wait` when it settles, adding `outcome` (CompactionOutcome).
   */
  | { t: 'compact'; id: number; treeId: string; branchId?: string; instructions?: string; wait?: boolean }
  /** Retry: asks the user entry `entryId` again as a new version beside it; resolves to its BranchMeta (R37). */
  | { t: 'regenerate'; id: number; treeId: string; branchId: string; entryId: number; requestId: string; model?: ModelInfo; effort?: Effort }
  /** Streams one branch of the tree (`branchId`, or the active one) and makes it the active one. */
  | { t: 'watch'; id: number; treeId: string; branchId?: string }
  | { t: 'unwatch'; id: number; treeId: string }
  | { t: 'files.list'; id: number; treeId: string }
  | { t: 'files.preview'; id: number; treeId: string; path: string }
  /** Resolves to `{ name, mimeType, base64 }`. */
  | { t: 'files.read'; id: number; treeId: string; path: string }
  | { t: 'files.delete'; id: number; treeId: string; path: string }
  /** At most 20 MB. Resolves to an UploadedFile. */
  | { t: 'upload'; id: number; name: string; base64: string }
  | { t: 'uploads'; id: number }
  /** Switches a plugin or changes some of its settings; `null` returns a value to its default or clears a secret. */
  | { t: 'plugin.set'; id: number; pluginId: string; enabled?: boolean; values?: Record<string, PluginValue | null>; secrets?: Record<string, string | null> }
  /** Switches one tool of a plugin; a tool that is off is not offered to the model. */
  | { t: 'plugin.tool.set'; id: number; pluginId: string; tool: string; enabled: boolean }
  /** Adds an MCP server (Streamable HTTP) as a plugin and connects; resolves to its PluginInfo. */
  | { t: 'mcp.add'; id: number; name: string; url: string; headers?: Record<string, string> }
  /** Changes a server's name, address or headers (`null` removes one) and reconnects. */
  | { t: 'mcp.update'; id: number; pluginId: string; name?: string; url?: string; headers?: Record<string, string | null> }
  | { t: 'mcp.remove'; id: number; pluginId: string }
  /** The Discover catalog (roadmap-6 B3); resolves to DiscoverItem[]. */
  | { t: 'discover'; id: number }
  | { t: 'mcp.reconnect'; id: number; pluginId: string }
  /** Starts the server's OAuth sign-in; resolves to `{ url }` for the browser to open. */
  | { t: 'mcp.auth'; id: number; pluginId: string }
  /** The view a tool's calls render with; resolves to a UiResource. */
  | { t: 'resource.read'; id: number; pluginId: string; uri: string }
  /** A view calls a tool (MCP Apps `tools/call`): only tools of `pluginId`, the view's own plugin. */
  | { t: 'tool.call'; id: number; treeId: string; pluginId: string; name: string; args: unknown }
  | { t: 'skill.set'; id: number; name: string; enabled: boolean }
  /** Installs every Skill found at the source; resolves to the SkillInfo[] it added or replaced. */
  | { t: 'skill.install'; id: number; source: SkillSource }
  | { t: 'skill.remove'; id: number; name: string }
  /** One file of a Skill, as text; resolves to a FilePreview. */
  | { t: 'skill.read'; id: number; name: string; path: string }
  /** Switches a channel or changes its settings; it reconnects with the new ones. */
  | { t: 'channel.set'; id: number; channelId: string; enabled?: boolean; values?: Record<string, PluginValue | null>; secrets?: Record<string, string | null> }
  /** A code the owner sends to the bot to pair their identity; resolves to `{ code, expiresAt }`. */
  | { t: 'channel.pair'; id: number; channelId: string }
  /** Lets `actorId` talk to the bot, for example someone a rejected Trigger named. */
  | { t: 'channel.allow'; id: number; channelId: string; actorId: string; name: string }
  | { t: 'channel.revoke'; id: number; channelId: string; actorId: string }
  /** The newest Triggers of a channel, newest first; resolves to TriggerInfo[]. */
  | { t: 'triggers.list'; id: number; channelId: string; limit?: number }
  /** Runs a login and replies when it ends; meanwhile the host sends `auth.event` and `auth.prompt` for `loginId`. */
  | { t: 'auth.login'; id: number; loginId: string; provider: string; type: AuthType }
  /** Answers an `auth.prompt`; without `value` the prompt is cancelled. */
  | { t: 'auth.answer'; id: number; promptId: string; value?: string }
  | { t: 'auth.cancel'; id: number; loginId: string }
  | { t: 'auth.logout'; id: number; provider: string }
  /**
   * A side question about the shown branch ("btw"): answered from its conversation so far, with no tools, and never
   * written to it. Streams `btw` messages to this socket; resolves to `{ text }`. `model` defaults to the branch's.
   */
  | { t: 'btw'; id: number; treeId: string; branchId?: string; requestId: string; question: string; model?: ModelInfo }
  /** Stops a side question; its request rejects. */
  | { t: 'btw.cancel'; id: number; requestId: string }
  | { t: 'schedule.create'; id: number; treeId: string; name: string; prompt: string; rule: ScheduleRule; tz: string }
  | { t: 'schedule.update'; id: number; scheduleId: string; enabled: boolean }
  | { t: 'schedule.delete'; id: number; scheduleId: string }
  /** A new webhook for the tree, replacing its old one; resolves to `{ webhook, secret }`, the secret shown only now. */
  | { t: 'webhook.create'; id: number; treeId: string }
  | { t: 'webhook.delete'; id: number; webhookId: string }
  /** 👍 / 👎 on a turn's answer (D1); `value: null` clears it. The server answers with the tree's `feedback`. */
  | { t: 'feedback.set'; id: number; treeId: string; turnId: string; value: 'up' | 'down' | null; reasons?: FeedbackReason[]; comment?: string }
  /** Marks inbox items read on every device (D3). */
  | { t: 'inbox.read'; id: number; ids: string[] }
  /** Resolves to a LibraryPage (D4): files of every conversation and project, newest first. */
  | { t: 'library.list'; id: number; query?: string; kind?: FileKind; cursor?: string; limit?: number }
  /** Starts an export of everything (D5); resolves to its ExportInfo at once, `exports` follows as it progresses. */
  | { t: 'export.create'; id: number }
  | { t: 'export.delete'; id: number; exportId: string }

export type ServerMessage =
  | { t: 'hello' }
  | { t: 'models'; models: ModelInfo[]; defaultModel: ModelInfo | null }
  | { t: 'providers'; providers: ProviderState[] }
  | { t: 'auth.event'; loginId: string; event: AuthEvent }
  | { t: 'auth.prompt'; loginId: string; promptId: string; prompt: LoginPrompt }
  /** The login no longer waits for this prompt (it was answered another way, or the login ended). */
  | { t: 'auth.prompt.done'; promptId: string }
  | { t: 'trees'; trees: TreeMeta[] }
  /** Sent for each watched tree on watch and whenever its branches change. */
  | ({ t: 'branches'; treeId: string } & BranchesState)
  | { t: 'plugins'; plugins: PluginInfo[] }
  /** `canInstall` is false when the server cannot unpack or fetch Skills. */
  | { t: 'skills'; skills: SkillInfo[]; canInstall: boolean }
  | { t: 'channels'; channels: ChannelInfo[] }
  | { t: 'prefs'; prefs: Preferences }
  /** All of the user's memories, newest first; sent on connect and after every change. */
  | { t: 'memories'; memories: Memory[] }
  /** All of the user's projects, newest first; sent on connect and after every change. */
  | { t: 'projects'; projects: Project[] }
  /** All of the user's share links, newest first; sent on connect and after every change. */
  | { t: 'shares'; shares: ShareInfo[] }
  /** The feedback on a watched tree's answers; sent when the tree is watched and after every change. */
  | { t: 'feedback'; treeId: string; feedback: Feedback[] }
  /** Follow-ups for the newest answer of a watched tree: sent on watch when it has some, and when they are generated. */
  | ({ t: 'suggestions'; treeId: string } & Suggestions)
  /** Inbox items read (newest INBOX_READ_KEPT); sent on connect and after every change. */
  | { t: 'inboxRead'; ids: string[] }
  /** The user's exports, newest first (at most 3 kept); sent on connect and whenever one changes. */
  | { t: 'exports'; exports: ExportInfo[] }
  /**
   * DeepSeek's server-side steps while an answer streams on a watched branch (C2, C3): the whole trace so far, each
   * time it changes. Superseded by the NATIVE_KIND entry once the assistant message is saved.
   */
  | { t: 'native'; treeId: string; branchId: string; trace: NativeTrace }
  | { t: 'schedules'; schedules: ScheduleInfo[] }
  /** `canCreate` is false when the host has no TOKEN_ENCRYPTION_KEY to seal a webhook's secret. */
  | { t: 'webhooks'; webhooks: WebhookInfo[]; canCreate: boolean }
  /** The watched branch's whole view; later `ops` apply to it. Sent on watch and whenever the host restarts the stream. */
  | { t: 'view'; treeId: string; branchId: string; value: unknown }
  /** Chord operations of one commit, encoded with a per-watch encoder; decode with a decoder reset at each `view`. */
  | { t: 'ops'; treeId: string; ops: WireOp[] }
  /** Durable compaction state on watch/reconnect and after status changes; failure clears after a summary succeeds. */
  | { t: 'compaction.state'; treeId: string; branchId: string; running: CompactionStatus[]; failure?: CompactionFailure }
  /** One task's lifecycle; an end with `error` is a failure. End alone does not mean a summary was placed. */
  | { t: 'compaction_start'; treeId: string; branchId: string; taskId: number; reason: CompactionReason; blocking: boolean }
  | { t: 'compaction_end'; treeId: string; branchId: string; taskId: number; reason: CompactionReason; error?: string }
  /** A placed summary, replayed on watch. `entryId` is its position in the full-history view; deduplicate by it. */
  | ({ t: 'compaction_summary'; treeId: string; branchId: string } & CompactionSummary)
  /** A side question's answer so far, to the socket that asked it. */
  | { t: 'btw'; requestId: string; text: string }
  | { t: 'reply'; id: number; value?: unknown; error?: string }

export type CompactionReason = 'manual' | 'threshold' | 'overflow'
export interface CompactionStatus {
  taskId: number
  reason: CompactionReason
  blocking: boolean
  attempt: number
  retry?: { at: number; error: string }
}
export interface CompactionFailure {
  taskId: number
  reason: CompactionReason
  error: string
}
/** How a compaction ended: a summary was placed, the history was too short to need one, or it failed or stopped. */
export type CompactionOutcome = { status: 'placed' } | { status: 'nothing' } | { status: 'failed'; error: string } | { status: 'aborted' }
export interface CompactionSummary {
  entryId: number
  /** The first original entry the model keeps verbatim. Older entries remain in the web transcript. */
  firstKeptEntryId: number
  reason: CompactionReason
  summary: string
}
/** pi's summary entries are present in `view.entries` alongside the complete original history. */
export const COMPACTION_KIND = 'pi.compaction'
/** The summary text of a `pi.compaction` entry, without the wrapper pi puts around it for the model. */
export const compactionSummaryText = (wrapped: string) =>
  wrapped.replace(/^The conversation history before this point was compacted into the following summary:\n\n<summary>\n/, '').replace(/\n<\/summary>$/, '')

/** Kind of the entry a host writes when a run ends without an answer; the model never sees it. */
export const RUN_ERROR_KIND = 'app.run-error'
export interface RunErrorData {
  reason: string
  detail?: string
}
