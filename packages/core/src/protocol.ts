// Messages between the browser and a host over one WebSocket (roadmap-3 D9). Type-only: the web client imports it too.
import type { WireOp } from '@earendil-works/chord/delta'
import type { PluginState, PluginValue } from './catalog.ts'

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

/** Requests carry an `id`; the host answers each with one `reply`. */
export type ClientRequest =
  | { t: 'tree.create'; id: number }
  | { t: 'tree.update'; id: number; treeId: string; title?: string; pinned?: boolean }
  | { t: 'tree.delete'; id: number; treeId: string }
  /** `attachments` are upload ids; they are copied into the tree's workspace. */
  | { t: 'send'; id: number; treeId: string; text: string; requestId: string; model?: ModelInfo; effort?: Effort; attachments?: string[] }
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

export type ServerMessage =
  | { t: 'hello'; email: string; models: ModelInfo[]; defaultModel: ModelInfo | null }
  | { t: 'trees'; trees: TreeMeta[] }
  | { t: 'plugins'; plugins: PluginState[] }
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
