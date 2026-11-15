// What the UI draws: a conversation's turns, projected from the server's view (lib/turns.ts).
import type { CompactionReason, EventData, Mention, NativeStep, ToolCallResult } from '@gense/protocol'

export type TurnStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'
export type ToolStatus = 'running' | 'succeeded' | 'failed'

/** A web page the answer drew on. */
export interface WebSource {
  url: string
  title: string
  site: string
}

export interface ToolCall {
  id: string
  name: string
  status: ToolStatus
  input: unknown
  result?: ToolCallResult
  durationMs?: number
}

/** One piece of an answer, in the order the model produced it. */
/** `native`: a search or page read DeepSeek ran itself (roadmap-7 C2); the transcript has no tool call for it. */
export type TurnBlock = { kind: 'text'; text: string } | { kind: 'thinking'; text: string } | { kind: 'tool'; call: ToolCall } | { kind: 'native'; step: NativeStep }

/** A file sent with a message; `id` is the upload's id, or the file's path once it is in the workspace. */
export interface Attachment {
  id: string
  name: string
  size?: number
  /** The server read it into text before the turn (roadmap-7 C6). */
  parsed?: { how: 'text' | 'ocr'; pages?: number }
}

export interface CommandRef {
  id: string
  label: string
}

/** Sibling versions of a message: branch ids, oldest first, and which one is shown. */
export interface Versions {
  ids: string[]
  index: number
}

export interface Turn {
  /** The entry that opened it: the user message's id, or `queued-…` while it waits. */
  id: string
  status: TurnStatus
  userMessage: string
  /** The answer's text alone, for copying. */
  assistantMessage: string
  blocks: TurnBlock[]
  /** Web pages its tools found, once each. */
  sources: WebSource[]
  error?: string
  /** `provider:id` of the model that answered. */
  model?: string
  createdAt: number
  /** Edits and regenerations of the message (R37). */
  versions?: Versions
  /** Last entry of the turn; a fork continues from here (R36). */
  lastEntryId?: number
  /** The entry before the user message (`start` for the first), where its versions branch off. */
  anchor?: string
  /** The conversation that wrote the user message. */
  writer?: number
  attachments?: Attachment[]
  command?: CommandRef
  mentions?: Mention[]
  /** Set when the turn starts with an Event rather than the user's message (R46). */
  event?: EventData
  /** Set when the app asked on the user's behalf (R40); the label it shows. */
  brief?: string
  /** DeepSeek's safety check refused the question (roadmap-7 C4): no answer, and asking again gives none. */
  refusal?: boolean
  /** Context compactions placed after this turn's content (roadmap-6 C4). */
  compactions?: Compaction[]
}

/** A summary that replaced older context for the model; the transcript above it stays as it was. */
export interface Compaction {
  id: number
  reason: CompactionReason
  summary: string
}

/** A message as the composer sends it. */
export interface Outgoing {
  text: string
  attachments?: Attachment[]
  command?: CommandRef & { prompt: string }
  mentions?: Mention[]
}
