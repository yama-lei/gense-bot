// Messages between the browser and a host over one WebSocket (roadmap-3 D9). Type-only: the web client imports it too.
import type { WireOp } from '@earendil-works/chord/delta'
import type { AuthEvent, AuthType } from '@earendil-works/pi-ai'
import type { PluginState, PluginValue } from './catalog.ts'
import type { CommandNote, Mention } from './notes.ts'

/** A conversation as the sidebar lists it. In stage 1 a tree is just its main branch. */
export interface TreeMeta {
  id: string
  title: string
  pinned: boolean
  createdAt: number
  updatedAt: number
}

export interface ModelInfo {
  provider: string
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

/** A shared Skill on the customize page. */
export interface SkillInfo {
  name: string
  description: string
  source: 'builtin' | 'drive'
  enabled: boolean
}

/** A tool's result as a view sees it (MCP `CallToolResult`). */
export interface ToolCallResult {
  content: string
  structuredContent?: unknown
  isError?: boolean
}

/** Requests carry an `id`; the host answers each with one `reply`. */
export type ClientRequest =
  | { t: 'tree.create'; id: number }
  | { t: 'tree.update'; id: number; treeId: string; title?: string; pinned?: boolean }
  | { t: 'tree.delete'; id: number; treeId: string }
  /** `attachments` are upload ids; they are copied into the tree's workspace. */
  | {
      t: 'send'
      id: number
      treeId: string
      text: string
      requestId: string
      model?: ModelInfo
      effort?: Effort
      attachments?: string[]
      command?: CommandNote
      mentions?: Mention[]
    }
  | { t: 'abort'; id: number; treeId: string }
  | { t: 'watch'; id: number; treeId: string }
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
  | { t: 'tool.call'; id: number; treeId: string; name: string; args: unknown }
  | { t: 'skill.set'; id: number; name: string; enabled: boolean }
  /** Runs a login and replies when it ends; meanwhile the host sends `auth.event` and `auth.prompt` for `loginId`. */
  | { t: 'auth.login'; id: number; loginId: string; provider: string; type: AuthType }
  /** Answers an `auth.prompt`; without `value` the prompt is cancelled. */
  | { t: 'auth.answer'; id: number; promptId: string; value?: string }
  | { t: 'auth.cancel'; id: number; loginId: string }
  | { t: 'auth.logout'; id: number; provider: string }

export type ServerMessage =
  | { t: 'hello'; email: string }
  | { t: 'models'; models: ModelInfo[]; defaultModel: ModelInfo | null }
  | { t: 'providers'; providers: ProviderState[] }
  | { t: 'auth.event'; loginId: string; event: AuthEvent }
  | { t: 'auth.prompt'; loginId: string; promptId: string; prompt: LoginPrompt }
  /** The login no longer waits for this prompt (it was answered another way, or the login ended). */
  | { t: 'auth.prompt.done'; promptId: string }
  | { t: 'trees'; trees: TreeMeta[] }
  | { t: 'plugins'; plugins: PluginState[] }
  | { t: 'skills'; skills: SkillInfo[] }
  /** The branch's whole view; later `ops` apply to it. Sent on watch and whenever the host restarts the stream. */
  | { t: 'view'; treeId: string; value: unknown }
  /** Chord operations of one commit, encoded with a per-watch encoder; decode with a decoder reset at each `view`. */
  | { t: 'ops'; treeId: string; ops: WireOp[] }
  | { t: 'reply'; id: number; value?: unknown; error?: string }

/** Kind of the entry a host writes when a run ends without an answer; the model never sees it. */
export const RUN_ERROR_KIND = 'app.run-error'
export interface RunErrorData {
  reason: string
  detail?: string
}
