// Messages between the browser and a host over one WebSocket (roadmap-3 D9). Type-only: the web client imports it too.
import type { WireOp } from '@earendil-works/chord/delta'

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

/** Requests carry an `id`; the host answers each with one `reply`. */
export type ClientRequest =
  | { t: 'tree.create'; id: number }
  | { t: 'tree.update'; id: number; treeId: string; title?: string; pinned?: boolean }
  | { t: 'tree.delete'; id: number; treeId: string }
  | { t: 'send'; id: number; treeId: string; text: string; requestId: string; model?: ModelInfo; effort?: Effort }
  | { t: 'abort'; id: number; treeId: string }
  | { t: 'watch'; id: number; treeId: string }
  | { t: 'unwatch'; id: number; treeId: string }

export type ServerMessage =
  | { t: 'hello'; email: string; models: ModelInfo[]; defaultModel: ModelInfo | null }
  | { t: 'trees'; trees: TreeMeta[] }
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
