// Plugin contract, aligned with MCP Apps (docs/design/architecture.md "插件与界面").
// In M1 the tool half moves to the server; the view half stays in the browser.
import type { ComponentType } from 'react'
import type { Conversation, DriveFile, ToolResult, WorkspaceFile } from '../types'

export interface ToolContext {
  files: DriveFile[]
  addFile: (file: DriveFile) => void
  conversations: Conversation[]
  /** The running chat's workspace (roadmap-2 "L0-6 会话工作区"). */
  workspace: {
    list: () => WorkspaceFile[]
    /** Null when the file does not exist. */
    read: (path: string) => string | null
    write: (path: string, text: string) => void
  }
}

export interface PluginTool {
  name: string
  plugin: string
  description: string
  /** `_meta.ui.resourceUri`; set only on render tools. */
  resourceUri?: string
  sideEffect: boolean
  execute: (input: never, ctx: ToolContext) => ToolResult
}

export type DisplayMode = 'inline' | 'panel' | 'fullscreen'

/** Host API given to a view; each method maps to an MCP Apps message. */
export interface ViewHost {
  /** `tools/call`: only tools of the view's own plugin. */
  callTool: (name: string, args: unknown) => Promise<ToolResult>
  /** `ui/message` */
  sendMessage: (text: string) => void
  /** `ui/request-display-mode`; `panel` is our extension for the side panel. */
  requestDisplayMode: (mode: DisplayMode) => void
  /** Extension: persist view state across reloads (ChatGPT's widgetState). */
  setViewState: (state: unknown) => void
}

export interface ViewProps<I = unknown, S = unknown, V = unknown> {
  /** `ui/notifications/tool-input` */
  toolInput: I
  /** `ui/notifications/tool-result` */
  toolResult?: ToolResult & { structuredContent?: S }
  displayMode: DisplayMode
  viewState?: V
  host: ViewHost
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type View = ComponentType<ViewProps<any, any, any>>
