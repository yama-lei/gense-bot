import type { PluginSetting, PluginSettingsState } from '@gense/core/catalog'
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
  /** Edits of the user message: sibling message ids, oldest first, and which one is shown. */
  userVersions?: Versions
  /** Regenerations of the answer, likewise. */
  answerVersions?: Versions
  /** Last message of the turn; forks and side threads branch off here. */
  lastMessageId?: string
  /** A side thread's summary brought back to this chat; such a turn has no user message. */
  note?: BranchNote
  /** Files sent with the user message (roadmap-2 R8). */
  attachments?: Attachment[]
  /** The `/` command the message was sent with (roadmap-2 R17). */
  command?: CommandRef
  /** Plugins, chats and workspace files `@`-mentioned in the message (R18); mentioned Drive files are attachments. */
  mentions?: Mention[]
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

export interface Versions {
  ids: string[]
  index: number
}

/** Summary of a side thread, added to the main chat as its own message. */
export interface BranchNote {
  sideChatId: string
  title: string
  summary: string
  /** The Markdown file in GenseBot/Artifacts, when Drive was connected. */
  fileId?: string
  fileName?: string
}

/** Where a chat branched off: a fork is a normal chat, a side thread hangs off its parent. */
export interface ChatParent {
  chatId: string
  messageId: string
  kind: 'fork' | 'side'
}

export interface Conversation {
  id: string
  title: string
  projectId: string | null
  pinned: boolean
  updatedAt: number
  turns: Turn[]
  parent?: ChatParent
  /** The turns shown are an older version (read-only), not the live conversation. */
  viewingOld?: boolean
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

/** Chats the sidebar and project pages list; side threads only show beside their parent. */
export const listed = (cs: Conversation[]) => cs.filter((c) => c.parent?.kind !== 'side')

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

export interface Schedule {
  id: string
  name: string
  rule: string
  nextRunAt: number
  enabled: boolean
  lastResult: string
}

export type { PluginSetting, PluginSettingsState, PluginValue } from '@gense/core/catalog'
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
export interface SkillInfo {
  name: string
  description: string
  source: 'builtin' | 'drive'
  enabled: boolean
}

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
  plugins: PluginInfo[]
  skills: SkillInfo[]
  /** Why GenseBot/Skills could not be read; null when fine. */
  skillsError: string | null
  memories: Memory[]
  prefs: Preferences
  account: Account
  /** Models served by the endpoints; `modelsError` explains an empty or stale list. */
  models: ModelOption[]
  modelsError: string | null
}
