// Plugins, Skills and channels as the server reports them to the web client. A plugin is a set of tools with settings;
// its provider is built in (a pi-durable extension in the server) or an MCP server the owner added. Pure types and
// functions: the browser imports this file too.

export type PluginValue = string | boolean

/** One setting of a plugin or channel; values are checked against it on the server. */
export interface PluginSetting {
  key: string
  label: string
  help?: string
  /** `secret` values are encrypted on the server and never sent back; `textarea` is a long `text`. */
  kind: 'text' | 'textarea' | 'url' | 'secret' | 'select' | 'toggle'
  options?: { value: string; label: string }[]
  default?: PluginValue
  placeholder?: string
}

/** Settings as the server sends them; secrets appear only as `secretsSet`. */
export interface PluginSettingsState {
  /** Values the owner set; others fall back to the server's, then to the declared default. */
  values: Record<string, PluginValue>
  secretsSet: string[]
  /** Keys the server configures (`.env`), used when the owner sets none. */
  serverKeys: string[]
}

/** A tool of a plugin. */
export interface ToolInfo {
  name: string
  /** Name to show; the tool name when absent. */
  title?: string
  description: string
  /** Offered to the model while its plugin is on. */
  enabled: boolean
  /** The view its calls render with (MCP Apps `_meta.ui.resourceUri`). */
  resourceUri?: string
  /** Only views call it; the model is never offered it. */
  viewOnly?: boolean
}

export type McpStatus = 'connecting' | 'ready' | 'auth' | 'error' | 'off'

/** An MCP server the owner added (Streamable HTTP). */
export interface McpServerState {
  url: string
  status: McpStatus
  /** Why it is not ready, for `error` and `auth`. */
  error?: string
  /** Names of the request headers the owner set; values never leave the server. */
  headersSet: string[]
  /** Signed in with OAuth. */
  oauth: boolean
  /** `serverInfo` of the initialize result. */
  server?: { name: string; version: string }
}

/** A plugin with its declaration and state. */
export interface PluginInfo {
  id: string
  kind: 'builtin' | 'mcp'
  name: string
  description: string
  /** Its tools change things outside the conversation. */
  sideEffect: boolean
  settings: PluginSetting[]
  enabled: boolean
  /** This server can run it. */
  available: boolean
  config: PluginSettingsState
  /** Why it offers no tools with its current settings; null when it does. */
  issue: string | null
  tools: ToolInfo[]
  /** Present for `kind: 'mcp'`. */
  mcp?: McpServerState
}

/** An MCP Apps view (`text/html;profile=mcp-app`) with what its `_meta.ui` asks for. */
export interface UiResource {
  uri: string
  html: string
  csp?: { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[]; baseUriDomains?: string[] }
  prefersBorder?: boolean
}

/** A Skill: a folder with a SKILL.md (Agent Skills). */
export interface SkillInfo {
  name: string
  description: string
  source: 'builtin' | 'upload' | 'git'
  /** Where an installed Skill came from: the archive's name or the Git URL. */
  origin?: string
  license?: string
  enabled: boolean
  /** Paths in its folder, relative to it, `SKILL.md` first. */
  files: string[]
}

/** Where to install Skills from: an uploaded zip (`upload` is its id), or a Git repository and a folder in it. */
export type SkillSource = { upload: string } | { git: string; ref?: string; path?: string }

export type ChannelStatus = 'off' | 'connecting' | 'ready' | 'error'

/** Someone a channel knows by its own identity (Feishu `open_id`). */
export interface ChannelActor {
  id: string
  name: string
  /** `owner` is paired with the owner; `allowed` may talk to the bot. */
  role: 'owner' | 'allowed'
  addedAt: number
}

/** A bot channel: a Source of Triggers and where answers to them go. */
export interface ChannelInfo {
  id: string
  name: string
  description: string
  settings: PluginSetting[]
  config: PluginSettingsState
  enabled: boolean
  status: ChannelStatus
  error?: string
  /** The bot account, once connected. */
  bot?: { name: string; avatar?: string }
  /** Who may talk to it; everyone else is refused and recorded. */
  actors: ChannelActor[]
}

export type TriggerDecision = 'accepted' | 'rejected' | 'duplicate' | 'command'

/** One inbound message of a channel, as the channel page lists it. */
export interface TriggerInfo {
  id: string
  source: string
  /** The source's thread: a private chat, or a topic of a group. */
  thread: { key: string; label: string; group: boolean }
  actor: { id: string; name: string }
  text: string
  decision: TriggerDecision
  /** Why it was rejected. */
  reason?: string
  treeId?: string
  createdAt: number
}

/** Whether `value` fits setting `s`; a select only takes one of its options. */
export function validSetting(s: PluginSetting, value: unknown): value is PluginValue {
  if (s.kind === 'toggle') return typeof value === 'boolean'
  if (typeof value !== 'string' || value.length > (s.kind === 'textarea' ? 20_000 : 2000)) return false
  if (s.kind === 'select') return !!s.options?.some((o) => o.value === value)
  if (s.kind === 'url' && value) return /^https?:\/\/[^\s]+$/.test(value)
  return true
}
