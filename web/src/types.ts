// Draft data model for the mock UI; see docs/specs/web-ui.md "数据模型草案".

export type TurnStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'
export type ToolStatus = 'running' | 'succeeded' | 'failed'
export type Effort = 'low' | 'medium' | 'high'
export type Provider = 'anthropic' | 'openai'

export interface Project {
  id: string
  name: string
  description: string
  pinned: boolean
}

/** A source excerpt; resolved against the file's current content when opened. */
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
  error?: string
  model: string
  effort: Effort
  createdAt: number
}

export interface Conversation {
  id: string
  title: string
  projectId: string | null
  pinned: boolean
  updatedAt: number
  turns: Turn[]
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
  /** Only the mock keeps file text in its state; the real store reads it on demand. */
  content?: string
}

export interface Schedule {
  id: string
  name: string
  rule: string
  nextRunAt: number
  enabled: boolean
  lastResult: string
}

/** A plugin as listed on the customize page. */
export interface PluginInfo {
  id: string
  name: string
  description: string
  sideEffect: boolean
  enabled: boolean
  available: boolean
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
  memories: Memory[]
  prefs: Preferences
  account: Account
  /** Models served by the endpoints; `modelsError` explains an empty or stale list. */
  models: ModelOption[]
  modelsError: string | null
}

/** A chat as listed by the user's hub; its turns live in the chat's own Durable Object. */
export interface ChatMeta {
  id: string
  title: string
  projectId: string | null
  pinned: boolean
  updatedAt: number
}

/** UserHub state, broadcast to every tab. Holds no secrets. */
export interface HubState {
  chats: ChatMeta[]
  projects: Project[]
  memories: Memory[]
  prefs: Preferences
  enabledPlugins: string[]
  /** Plugins whose tools the server implements. */
  availablePlugins: string[]
  account: Account
  models: ModelOption[]
  modelsError: string | null
  /** GenseBot/资料 and GenseBot/Artifacts, refreshed from Drive. */
  files: DriveFile[]
}

/** What a chat asks its hub for before each turn. */
export interface TurnSettings {
  enabledPlugins: string[]
  memories: string[]
  language: string
  models: ModelOption[]
  driveConnected: boolean
  /** Name and description of the chat's project, empty when it has none. */
  projectContext: string
}

/** Client body fields sent with each chat request. */
export interface TurnBody {
  model: string
  effort: Effort
}

/** Metadata the server stamps on each assistant message. */
export interface TurnMetadata {
  model: string
  effort: Effort
  createdAt: number
}
