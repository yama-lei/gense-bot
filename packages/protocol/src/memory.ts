// Memory and projects (roadmap-7 A): kept per user on the server, sent to the model in web and channel conversations.

/** Who wrote an entry: the user on the Memory page, the user saving an answer, or the model through its `memory` tool. */
export type MemorySource = 'manual' | 'saved' | 'model'

export interface Memory {
  id: string
  text: string
  source: MemorySource
  /** The conversation it came from, for `saved` and `model`. */
  treeId: string | null
  /** Only sent to the model inside this project's conversations; null for every conversation (Q2). */
  projectId: string | null
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export const MEMORY_LIMITS = {
  /** Entries per user, enabled or not. */
  entries: 200,
  /** Characters of one entry. */
  text: 500,
  /** Characters of the memory section the model sees; the newest entries win when the enabled ones exceed it. */
  prompt: 8_000,
} as const

/**
 * `details` of a `memory` tool result, so the answer shows "已记住" with an undo:
 * undo an `add` with `memory.remove`, an `update` with `memory.update` back to `previous`, a `remove` with `memory.add` of `previous`.
 */
export interface MemoryToolDetails {
  action: 'add' | 'update' | 'remove'
  /** The entry after the change; for `remove`, the entry as it was. */
  memory: Memory
  /** For `update` and `remove`: the entry before the change. */
  previous?: Memory
}

export interface Project {
  id: string
  name: string
  /** Index into the web client's project palette. */
  color: number
  /** A section of the system prompt in every conversation of the project. */
  instructions: string
  createdAt: number
  updatedAt: number
}

export const PROJECT_LIMITS = {
  name: 100,
  instructions: 20_000,
  /** Bytes of all files of one project. */
  files: 200 * 1024 * 1024,
} as const

/** Where a project's files appear in the sandbox, read-only, for its conversations. */
export const projectDir = (projectId: string) => `/data/projects/${projectId}`
