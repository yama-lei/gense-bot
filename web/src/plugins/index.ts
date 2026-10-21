// Plugin registry: tools by name, views by resourceUri.
import { artifactTools } from './artifact/tools'
import { ArtifactView } from './artifact/views'
import { coreTools } from './core/tools'
import { emailTools } from './email/tools'
import { EmailDraftView } from './email/views'
import { filesTools } from './files/tools'
import type { PluginTool, View } from './types'
import { webTools } from './web/tools'

export const tools: Record<string, PluginTool> = Object.fromEntries([...filesTools, ...artifactTools, ...emailTools, ...webTools, ...coreTools].map((t) => [t.name, t]))

/** Built-in React views. MCP Apps resources (`text/html;profile=mcp-app`) will render in a sandboxed iframe later. */
export const views: Record<string, View> = {
  'ui://artifact/view': ArtifactView,
  'ui://email/draft': EmailDraftView,
}
