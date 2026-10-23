import type { ReactNode } from 'react'
import type { AuthType } from '@earendil-works/pi-ai'
import type { LoginHandlers } from './pi/socket'
import { usePiStore } from './pi/store'
import type { AppState, Conversation, DriveFile, Effort, Outgoing, PluginValue, ToolResult, Turn, WorkspacePreview } from './types'

/** What the views need from the data layer; the host-backed store provides it. */
export interface Store {
  state: AppState
  /** False until the first server state arrives; views show loading instead of "not found". */
  ready: boolean
  /** Whether an open conversation's turns have arrived. */
  turnsLoaded: (convId: string) => boolean
  setState: (fn: (s: AppState) => AppState) => void
  patchConv: (convId: string, fn: (c: Conversation) => Conversation) => void
  /** Resolves to the new conversation's id; the first message is sent once its chat is open. */
  startConversation: (message: Outgoing, projectId: string | null, model: string, effort: Effort) => Promise<string>
  reply: (convId: string, message: Outgoing, model: string, effort: Effort) => void
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
  /** Uploads any file (at most 20 MB); attached to a message, it is copied into the chat's workspace. Rejects with a message for the user. */
  upload: (file: File) => Promise<DriveFile>
  setDrive: (connected: boolean) => void
  /** Changes some of a plugin's settings; null returns a value to its default and clears a secret. Rejects with a message for the user. */
  setPluginConfig: (id: string, values: Record<string, PluginValue | null>, secrets: Record<string, string | null>) => Promise<void>
  /** Turns a plugin on or off; rejects with a message for the user. */
  setPluginEnabled: (id: string, enabled: boolean) => Promise<void>
  /** Reloads the uploaded files into `AppState.files`. */
  refreshFiles: () => void
  /** Turns a shared Skill on or off; rejects with a message for the user. */
  setSkillEnabled: (name: string, enabled: boolean) => Promise<void>
  /** Signs in to a model service with the user's own key or subscription; `done` rejects with a message for the user. */
  loginModel: (provider: string, type: AuthType, handlers: LoginHandlers) => { done: Promise<void>; cancel: () => void }
  /** Answers a login prompt; without a value it cancels the prompt. */
  answerLogin: (promptId: string, value?: string) => Promise<void>
  /** Forgets the user's credential for a model service; rejects with a message for the user. */
  logoutModel: (provider: string) => Promise<void>
  /** Text of any readable Drive file; rejects with a message for the user. */
  readFile: (id: string) => Promise<{ file: DriveFile; text: string }>
  /** Name and full-text search across the user's Drive. */
  searchDrive: (query: string) => Promise<DriveFile[]>
  /** Reloads a connected chat's workspace file list into `Conversation.files`. */
  refreshWorkspace: (convId: string) => void
  /** The start of a workspace file; rejects with a message for the user. */
  workspacePreview: (convId: string, path: string) => Promise<WorkspacePreview>
  /** Deletes a file or folder in the chat's workspace; rejects with a message for the user. */
  deleteWorkspaceFile: (convId: string, path: string) => Promise<void>
  /** Saves a workspace or Skill file to the user's computer; rejects with a message for the user. */
  downloadWorkspaceFile: (convId: string, path: string) => Promise<void>
  /** A workspace file's content, for views that show files a tool wrote. */
  readWorkspaceFile: (convId: string, path: string) => Promise<Blob>
  /** Ends the session; the app returns to the login page. */
  logout: () => Promise<void>
  /** Connections the store keeps mounted (the open chat); App renders it. */
  bridge: ReactNode
}

export const useStore: (onUnauthorized: () => void) => Store = usePiStore
