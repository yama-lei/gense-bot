// The built-in plugins' views, by the resourceUri their tools declare. Which tool belongs to which plugin comes from
// the server (lib/tools.ts); a resourceUri without an entry here is an MCP Apps page and renders in a sandboxed frame.
import { ArtifactView } from './artifact/views'
import { EmailDraftView } from './email/views'
import { ImageView } from './image/views'
import type { View } from './types'
import { UiView } from './ui/views'

export const views: Record<string, View> = {
  'ui://artifact/view': ArtifactView,
  'ui://email/draft': EmailDraftView,
  'ui://ui/render': UiView,
  'ui://image/view': ImageView,
}

/** Views that draw from the input alone while the call still runs. */
export const liveViews = new Set(['ui://image/view', 'ui://ui/render'])
