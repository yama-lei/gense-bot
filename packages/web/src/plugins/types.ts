// Plugin contract, aligned with MCP Apps (docs/design/architecture.md "插件与界面").
// Tools run on the host; views run in the browser.
import type { ComponentType } from 'react'
import type { ToolResult } from '../types'

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
  /** Extension: a file in the chat's workspace, such as one the tool wrote. */
  readFile: (path: string) => Promise<Blob>
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
