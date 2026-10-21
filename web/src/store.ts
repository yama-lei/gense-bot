import type { ReactNode } from 'react'
import { MOCK } from './mode'
import { useMockStore } from './mock/store'
import { useRealStore } from './real/store'
import type { AppState, Conversation, DriveFile, Effort, ToolResult, Turn } from './types'

/** What the views need from the data layer; the mock and the Worker-backed store both provide it. */
export interface Store {
  state: AppState
  /** False until the first server state arrives; views show loading instead of "not found". */
  ready: boolean
  /** Whether an open conversation's turns have arrived. */
  turnsLoaded: (convId: string) => boolean
  setState: (fn: (s: AppState) => AppState) => void
  patchConv: (convId: string, fn: (c: Conversation) => Conversation) => void
  /** Resolves to the new conversation's id; the first message is sent once its chat is open. */
  startConversation: (message: string, projectId: string | null, model: string, effort: Effort) => Promise<string>
  reply: (convId: string, message: string, model: string, effort: Effort) => void
  /** A new answer beside the turn's current one; the old answer stays as an older version. */
  regenerate: (convId: string, turn: Turn, model: string, effort: Effort) => void
  /** Sends an edited copy of the turn's message; the original stays as an older version. */
  editMessage: (convId: string, turn: Turn, text: string, model: string, effort: Effort) => void
  /** Shows the version that contains `messageId` (read-only when older); an empty id shows the live conversation. */
  showVersion: (convId: string, messageId: string) => void
  /** A new chat holding the conversation up to the end of `turn`; resolves to its id. */
  branch: (convId: string, turn: Turn, kind: 'fork' | 'side') => Promise<string>
  /** Summarizes a side thread into its parent chat; rejects with a message for the user. */
  summarizeSide: (sideId: string) => Promise<void>
  /** Keeps one more chat connected besides the open one (the side thread panel). */
  attach: (convId: string | null) => void
  stop: (convId: string, turnId: string) => void
  reset: () => void
  /** `tools/call` from the view rendered by tool call `callId`; the call id makes retries idempotent. */
  callToolFromView: (convId: string, turnId: string, callId: string, name: string, input: unknown) => Promise<ToolResult>
  setViewState: (convId: string, turnId: string, callId: string, viewState: unknown) => void
  /** Returns an error message, or null when the file was added. */
  upload: (file: File) => Promise<string | null>
  setDrive: (connected: boolean) => void
  /** Reloads GenseBot/资料 and Artifacts from Drive. */
  refreshFiles: () => void
  /** Text of any readable Drive file; rejects with a message for the user. */
  readFile: (id: string) => Promise<{ file: DriveFile; text: string }>
  /** Name and full-text search across the user's Drive. */
  searchDrive: (query: string) => Promise<DriveFile[]>
  /** Connections the store keeps mounted (the open chat); App renders it. */
  bridge: ReactNode
}

// The mode is fixed at build time, so the hook choice never changes between renders.
export const useStore: () => Store = MOCK ? useMockStore : useRealStore
