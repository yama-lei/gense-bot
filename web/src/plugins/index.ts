// Plugin registry: tools by name, views by resourceUri.
import { artifactTools } from './artifact/tools'
import { ArtifactView } from './artifact/views'
import { coreTools } from './core/tools'
import { emailTools } from './email/tools'
import { EmailDraftView } from './email/views'
import { filesTools } from './files/tools'
import { imageTools } from './image/tools'
import { ImageView } from './image/views'
import type { PluginTool, View } from './types'
import { uiTools } from './ui/tools'
import { UiView } from './ui/views'
import { webTools } from './web/tools'

export const tools: Record<string, PluginTool> = Object.fromEntries([...filesTools, ...artifactTools, ...emailTools, ...webTools, ...imageTools, ...uiTools, ...coreTools].map((t) => [t.name, t]))

/** Built-in React views. MCP Apps resources (`text/html;profile=mcp-app`) will render in a sandboxed iframe later. */
export const views: Record<string, View> = {
  'ui://artifact/view': ArtifactView,
  'ui://email/draft': EmailDraftView,
  'ui://ui/render': UiView,
  'ui://image/view': ImageView,
}

/** Views that render from the input alone, while the call runs (a placeholder until the result). */
export const liveViews = new Set(['ui://image/view'])
