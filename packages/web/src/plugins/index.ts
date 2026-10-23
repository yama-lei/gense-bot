// Plugin registry for the browser: which plugin a tool belongs to, and views by resourceUri.
import { ArtifactView } from './artifact/views'
import { EmailDraftView } from './email/views'
import { ImageView } from './image/views'
import type { View } from './types'
import { UiView } from './ui/views'

/** Tools the browser knows about; `resourceUri` is the view a call renders with. */
export const tools: Record<string, { plugin: string; resourceUri?: string }> = {
  artifact_create: { plugin: 'artifact', resourceUri: 'ui://artifact/view' },
  artifact_save: { plugin: 'artifact' },
  email_draft: { plugin: 'email', resourceUri: 'ui://email/draft' },
  image_generate: { plugin: 'image', resourceUri: 'ui://image/view' },
  ui_render: { plugin: 'ui', resourceUri: 'ui://ui/render' },
}

/** Built-in React views. MCP Apps resources (`text/html;profile=mcp-app`) will render in a sandboxed iframe later. */
export const views: Record<string, View> = {
  'ui://artifact/view': ArtifactView,
  'ui://email/draft': EmailDraftView,
  'ui://ui/render': UiView,
  'ui://image/view': ImageView,
}

/** Views that render from the input alone, while the call runs (a placeholder until the result). */
export const liveViews = new Set(['ui://image/view'])
