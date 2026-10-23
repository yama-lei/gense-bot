import type { PluginSetting, PluginSettingsState } from '@gense/core/catalog'
import type { BranchesState, EventData, ProviderState, ScheduleInfo, SkillInfo, WebhookInfo } from '@gense/core/protocol'
// The UI's data model; see docs/specs/web-ui.md "数据模型草案".

export type TurnStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'
export type ToolStatus = 'running' | 'succeeded' | 'failed'
export type Effort = 'low' | 'medium' | 'high'
export type Provider = string

export interface Project {
  id: string
  name: string
  description: string
  pinned: boolean
}

/** A source excerpt; resolved against the file's current content when opened. */
/** A web page the answer drew on (web plugin). */
export interface WebSource {
  url: string
  title: string
  /** Site name or host, shown on the source card. */
  site: string
}

export interface Citation {
  fileId: string
  name: string
  quote: string
}

/** Mirrors MCP CallToolResult: `content` is for the model, `structuredContent` for views. */
export interface ToolResult {
  content: string
  structuredContent?: unknown
  isError?: boolean
}

export interface ToolCall {
  id: string
  name: string
  status: ToolStatus
  input: unknown
  result?: ToolResult
  /** `_meta.ui.resourceUri` of the tool, when it renders a view. */
  resourceUri?: string
  /** Calls made by a view through host.callTool rather than by the model. */
  origin: 'model' | 'view'
  /** Persisted view state (MCP Apps has no standard field; mirrors ChatGPT's widgetState). */
  viewState?: unknown
  durationMs?: number
}

export interface Turn {
  id: string
  requestId: string
  status: TurnStatus
  userMessage: string
  summary?: string
  assistantMessage: string
  toolCalls: ToolCall[]
  citations: Citation[]
  /** Web pages found by web tools in this turn, deduplicated by URL. */
  sources?: WebSource[]
  error?: string
  model: string
  effort: Effort
  createdAt: number
  /** Edits and regenerations of the message (R37): the branches that each have their own version, and the shown one. */
  userVersions?: Versions
  /** Last entry of the turn; a fork continues from here (R36). */
  lastMessageId?: string
  /** The entry before the user message (`start` for the first), where its versions branch off. */
  anchor?: string
  /** The conversation that wrote the user message. */
  writer?: number
  /** Files sent with the user message (roadmap-2 R8). */
  attachments?: Attachment[]
  /** The `/` command the message was sent with (roadmap-2 R17). */
  command?: CommandRef
  /** Plugins, chats and workspace files `@`-mentioned in the message (R18); mentioned Drive files are attachments. */
  mentions?: Mention[]
  /** Set when the turn starts with an Event rather than the user's message (R46): a schedule, a webhook, a branch's report. */
  event?: EventData
  /** Set when the app asked on the user's behalf, such as "summarize to the main line" (R40); the label it shows. */
  brief?: string
}

/** A Drive file attached to a user message. */
export type Attachment = Pick<DriveFile, 'id' | 'name' | 'mimeType' | 'size'>

/** A `/` command as recorded on a message. */
export interface CommandRef {
  id: string
  label: string
}

/** An `@`-mentioned plugin, chat or workspace file (`id` is its path). */
export interface Mention {
  kind: 'plugin' | 'chat' | 'workspace'
  id: string
  label: string
}

/** Metadata of a user message; each field also has a hidden text part for the model (src/message.ts). */
export interface UserMetadata {
  attachments?: Attachment[]
  command?: CommandRef
  mentions?: Mention[]
}

/** A message as the composer sends it. */
export interface Outgoing {
  text: string
  attachments?: Attachment[]
  /** `prompt` is the instruction the model gets; only `id` and `label` are shown. */
  command?: CommandRef & { prompt: string }
  mentions?: Mention[]
}

/** Sibling versions of a message: branch ids, oldest first, and which one is shown. */
export interface Versions {
  ids: string[]
  index: number
}

export interface Conversation {
  id: string
  title: string
  projectId: string | null
  pinned: boolean
  updatedAt: number
  /** The turns of the shown branch. */
  turns: Turn[]
  /** The tree's branches (R35) once its view has arrived, and the one shown. */
  branches?: BranchesState
  branchId?: string
  /** Files in the chat's workspace; undefined until loaded. */
  files?: WorkspaceFile[]
}

/** The start of a workspace file, for the file panel's preview. */
export interface WorkspacePreview {
  text: string
  size: number
  /** Only the first part of the file is in `text`. */
  truncated: boolean
  /** Not UTF-8 text; `text` is empty. */
  binary: boolean
}

/** A file in a chat's workspace (roadmap-2 "L0-6 会话工作区"). Paths are absolute. */
export interface WorkspaceFile {
  path: string
  size: number
  mtime: number
  /** Under the read-only /skills mount. */
  readOnly: boolean
}

/** A Drive file: under GenseBot/资料 (`source`), GenseBot/Artifacts (`artifact`) or elsewhere in Drive (`drive`). */
export interface DriveFile {
  id: string
  name: string
  kind: 'source' | 'artifact' | 'drive'
  mimeType: string
  /** Bytes; null for Google Docs, which have no stored size. */
  size: number | null
  modifiedTime: number
}

export type Schedule = ScheduleInfo
export type { EventData, ScheduleRule, WebhookInfo } from '@gense/core/protocol'

export type { PluginSetting, PluginSettingsState, PluginValue } from '@gense/core/catalog'
export type { ProviderState, SkillInfo }
/** A plugin as listed on the customize page. */
export interface PluginInfo {
  id: string
  name: string
  description: string
  sideEffect: boolean
  enabled: boolean
  /** The server implements it. */
  available: boolean
  settings: PluginSetting[]
  config: PluginSettingsState
  /** Why it cannot be turned on with its current settings; null when it can. */
  issue: string | null
}

/** An Agent Skill (roadmap-2 R19): built in, or `GenseBot/Skills/<名称>/SKILL.md` in Drive. */

export interface Memory {
  id: string
  text: string
}

/** A model served by one of the endpoints; capabilities come from models.dev (null when unknown). */
export interface ModelOption {
  provider: Provider
  id: string
  name: string
  capabilities: {
    toolCall: boolean
    efforts: Effort[]
    context: number
    /** Accepts images as input (models.dev `modalities.input`). */
    image: boolean
  } | null
}

export interface Preferences {
  language: string
  defaultEffort: Effort
  /** `provider:id` of the model last chosen. */
  model: string
}

export interface Account {
  name: string
  email: string
  driveConnected: boolean
  /** Why Drive is unavailable (grant revoked, API error); null when fine. */
  driveError: string | null
}

export interface AppState {
  projects: Project[]
  conversations: Conversation[]
  files: DriveFile[]
  schedules: Schedule[]
  /** One per conversation at most (R50). */
  webhooks: WebhookInfo[]
  plugins: PluginInfo[]
  skills: SkillInfo[]
  /** Model services the user can sign in to; their models join `models`. */
  providers: ProviderState[]
  memories: Memory[]
  prefs: Preferences
  account: Account
  /** Models served by the endpoints; `modelsError` explains an empty or stale list. */
  models: ModelOption[]
  modelsError: string | null
}
