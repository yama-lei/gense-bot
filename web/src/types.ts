// Draft data model for the mock UI; see docs/specs/web-ui.md "数据模型草案".

export type TurnStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'
export type ToolStatus = 'running' | 'succeeded' | 'failed'
export type Effort = 'low' | 'medium' | 'high'

export interface Project {
  id: string
  name: string
  description: string
  pinned: boolean
}

export interface Citation {
  path: string
  line: number
}

export interface ToolCall {
  id: string
  name: string
  status: ToolStatus
  args: string
  output?: string
  durationMs?: number
}

export interface Confirmation {
  kind: 'email'
  fields: { label: string; value: string }[]
  consequence: string
  state: 'pending' | 'confirmed' | 'cancelled'
}

export interface Turn {
  id: string
  requestId: string
  status: TurnStatus
  userMessage: string
  summary?: string
  assistantMessage: string
  toolCalls: ToolCall[]
  citations: Citation[]
  confirmation?: Confirmation
  error?: string
  model: string
  effort: Effort
  createdAt: number
}

export interface Conversation {
  id: string
  title: string
  projectId: string | null
  pinned: boolean
  updatedAt: number
  turns: Turn[]
}

export interface Doc {
  path: string
  content: string
  updatedAt: number
}

export interface Schedule {
  id: string
  name: string
  rule: string
  nextRunAt: number
  enabled: boolean
  lastResult: string
}

export interface Tool {
  id: string
  name: string
  description: string
  sideEffect: boolean
  enabled: boolean
  available: boolean
}

export interface Memory {
  id: string
  text: string
}

export interface Preferences {
  language: string
  defaultEffort: Effort
  model: string
}

export interface AppState {
  projects: Project[]
  conversations: Conversation[]
  docs: Doc[]
  schedules: Schedule[]
  tools: Tool[]
  memories: Memory[]
  prefs: Preferences
}
