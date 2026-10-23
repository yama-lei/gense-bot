// Messages between the browser and a host over one WebSocket (roadmap-3 D9). Type-only: the web client imports it too.
import type { WireOp } from '@earendil-works/chord/delta'
import type { AuthEvent, AuthType } from '@earendil-works/pi-ai'
import type { PluginState, PluginValue } from './catalog.ts'
import type { CommandNote, Mention } from './notes.ts'

/** A conversation as the sidebar lists it: a tree of branches, titled by its main branch (roadmap-3 R35). */
export interface TreeMeta {
  id: string
  title: string
  pinned: boolean
  createdAt: number
  updatedAt: number
}

export type BranchRole = 'main' | 'user' | 'agent'
export type BranchStatus = 'idle' | 'running' | 'done' | 'failed' | 'aborted'

/** One conversation of a tree (roadmap-3 D2). Entry ids are global, so they order fork points across branches. */
export interface BranchMeta {
  id: string
  parentId: string | null
  /** pi-durable conversation id; view entries carry it, so a client tells which branch wrote an entry. */
  conversationId: number
  /** Entry of the parent's transcript it continues from; null when it starts empty (a version of the first message). */
  forkEntryId: number | null
  role: BranchRole
  /** Its first message; empty while it has none. */
  title: string
  status: BranchStatus
  /** Newest entry, and the start of its newest answer, for the tree map. */
  lastEntryId: number | null
  preview: string
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
  /** A new branch continuing `at` (an entry of `branchId`'s transcript); resolves to its BranchMeta (R36). */
  | { t: 'branch.fork'; id: number; treeId: string; branchId: string; at: number }
  /** Asks the user entry `entryId` again in a new branch beside it; resolves to its BranchMeta (R37). */
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
  /** Sent for each watched tree on watch and whenever its branches change. */
  | ({ t: 'branches'; treeId: string } & BranchesState)
  | { t: 'plugins'; plugins: PluginState[] }
  | { t: 'skills'; skills: SkillInfo[] }
  /** The watched branch's whole view; later `ops` apply to it. Sent on watch and whenever the host restarts the stream. */
  | { t: 'view'; treeId: string; branchId: string; value: unknown }
  /** Chord operations of one commit, encoded with a per-watch encoder; decode with a decoder reset at each `view`. */
  | { t: 'ops'; treeId: string; ops: WireOp[] }
  | { t: 'reply'; id: number; value?: unknown; error?: string }

/** Kind of the entry a host writes when a run ends without an answer; the model never sees it. */
export const RUN_ERROR_KIND = 'app.run-error'
export interface RunErrorData {
  reason: string
  detail?: string
}
