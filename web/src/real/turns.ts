import type { UIMessage } from 'ai'
import { tools } from '../plugins'
import type { Citation, Effort, ToolCall, ToolResult, Turn, TurnMetadata } from '../types'

export type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error'

interface ToolPart {
  type: string
  toolCallId: string
  toolName?: string
  state: string
  input?: unknown
  output?: unknown
  errorText?: string
}

const isToolPart = (p: UIMessage['parts'][number]): p is UIMessage['parts'][number] & ToolPart => p.type.startsWith('tool-') || p.type === 'dynamic-tool'

function toolCall(p: ToolPart): ToolCall {
  const name = p.type === 'dynamic-tool' ? (p.toolName ?? 'tool') : p.type.slice('tool-'.length)
  const base = { id: p.toolCallId, name, input: p.input ?? {}, resourceUri: tools[name]?.resourceUri, origin: 'model' as const }
  if (p.state === 'output-available') {
    const output = p.output as ToolResult | undefined
    return { ...base, status: output?.isError ? 'failed' : 'succeeded', result: output }
  }
  if (p.state === 'output-error' || p.state === 'output-denied') return { ...base, status: 'failed', result: { content: p.errorText ?? '工具调用失败', isError: true } }
  return { ...base, status: 'running' }
}

const text = (m: UIMessage) =>
  m.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')

/**
 * Projects the chat transcript onto the UI's turns: a user message opens a turn and the
 * assistant messages after it fill it. Only the last turn can still be in flight.
 */
export function toTurns(
  messages: UIMessage[],
  opts: {
    status: ChatStatus
    streaming: boolean
    error?: string
    stopped: ReadonlySet<string>
    viewStates: Record<string, unknown>
    defaultEffort: Effort
    defaultModel: string
  },
): Turn[] {
  const turns: Turn[] = []
  for (const m of messages) {
    if (m.role === 'user' || turns.length === 0) {
      turns.push({
        id: m.id,
        requestId: m.id,
        status: 'succeeded',
        userMessage: m.role === 'user' ? text(m) : '',
        assistantMessage: '',
        toolCalls: [],
        citations: [],
        model: opts.defaultModel,
        effort: opts.defaultEffort,
        createdAt: Date.now(),
      })
      if (m.role === 'user') continue
    }
    if (m.role !== 'assistant') continue
    const t = turns.at(-1)!
    const meta = m.metadata as Partial<TurnMetadata> | undefined
    t.assistantMessage += text(m)
    for (const call of m.parts.filter(isToolPart).map(toolCall)) {
      if (call.id in opts.viewStates) call.viewState = opts.viewStates[call.id]
      // files_cite only records citations; they show under the answer, not in the process list.
      const cited = call.name === 'files_cite' && (call.result?.structuredContent as { citations?: Citation[] } | undefined)?.citations
      if (cited) t.citations.push(...cited)
      t.toolCalls.push(call)
    }
    if (meta?.model) t.model = meta.model
    if (meta?.effort) t.effort = meta.effort
    if (meta?.createdAt) t.createdAt = meta.createdAt
  }

  const last = turns.at(-1)
  if (last) {
    const answered = last.assistantMessage !== '' || last.toolCalls.length > 0
    if (opts.stopped.has(last.id)) last.status = 'interrupted'
    else if (opts.status === 'error') last.status = 'failed'
    else if (opts.status === 'submitted' && !answered) last.status = 'queued'
    else if (opts.status === 'submitted' || opts.status === 'streaming' || opts.streaming) last.status = 'running'
    if (last.status === 'failed') last.error = opts.error ?? '请求失败'
    // A stopped or failed turn leaves no tool running.
    if (last.status === 'interrupted' || last.status === 'failed')
      last.toolCalls = last.toolCalls.map((c) => (c.status === 'running' ? { ...c, status: 'failed', result: { content: '未完成', isError: true } } : c))
  }
  return turns
}
