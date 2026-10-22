import type { UIMessage } from 'ai'
import { tools } from '../plugins'
import type { BranchNote, Citation, Effort, ToolCall, ToolResult, Turn, TurnMetadata, UserMetadata, Versions, WebSource } from '../types'
import { isHiddenNote } from '../message'

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
    // Provider-executed tools (e.g. an endpoint's own image_generation) return their own shapes.
    if (typeof output?.content !== 'string') return { ...base, status: p.errorText ? 'failed' : 'succeeded', result: { content: p.errorText ?? '（没有文字结果）', isError: !!p.errorText } }
    return { ...base, status: output.isError ? 'failed' : 'succeeded', result: output }
  }
  if (p.state === 'output-error' || p.state === 'output-denied') return { ...base, status: 'failed', result: { content: p.errorText ?? '工具调用失败', isError: true } }
  return { ...base, status: 'running' }
}

const dedupe = (sources: WebSource[]) => [...new Map(sources.map((s) => [s.url, s])).values()]

const text = (m: UIMessage) =>
  m.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && !isHiddenNote(p.text))
    .map((p) => p.text)
    .join('')

const userExtras = (meta: UserMetadata | undefined) => ({ attachments: meta?.attachments, command: meta?.command, mentions: meta?.mentions })

/** Process line naming the tools loaded and the skills and chats a turn drew on (R19, R22: both show in the process summary). */
function processSummary(calls: ToolCall[]) {
  const skills = [...new Set(calls.filter((c) => c.name === 'skill_activate').map((c) => (c.input as { name?: string }).name).filter(Boolean))]
  const chats = new Set(calls.filter((c) => c.name === 'chats_read').map((c) => (c.input as { id?: string }).id)).size
  const loaded = [...new Set(calls.filter((c) => c.name === 'tools_load').flatMap((c) => (c.result?.structuredContent as { names?: string[] } | undefined)?.names ?? []))]
  return [loaded.length && `加载工具：${loaded.join('、')}`, skills.length && `使用 Skill：${skills.join('、')}`, chats && `读取 ${chats} 个会话`].filter(Boolean).join(' · ') || undefined
}

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
    /** Sibling ids of messages that have several versions (Chat.versions). */
    siblings: Record<string, string[]>
  },
): Turn[] {
  const versions = (id: string): Versions | undefined => {
    const ids = opts.siblings[id]
    return ids && { ids, index: ids.indexOf(id) }
  }
  const turns: Turn[] = []
  for (const m of messages) {
    const note = (m.metadata as { branchNote?: BranchNote } | undefined)?.branchNote
    if (note) {
      const at = (m.metadata as Partial<TurnMetadata>).createdAt ?? Date.now()
      turns.push({ id: m.id, requestId: m.id, status: 'succeeded', userMessage: '', assistantMessage: '', toolCalls: [], citations: [], model: opts.defaultModel, effort: opts.defaultEffort, createdAt: at, lastMessageId: m.id, note })
      continue
    }
    if (m.role === 'user' || turns.length === 0 || turns.at(-1)!.note) {
      turns.push({
        id: m.id,
        requestId: m.id,
        status: 'succeeded',
        userMessage: m.role === 'user' ? text(m) : '',
        ...(m.role === 'user' ? userExtras(m.metadata as UserMetadata | undefined) : {}),
        assistantMessage: '',
        toolCalls: [],
        citations: [],
        model: opts.defaultModel,
        effort: opts.defaultEffort,
        createdAt: Date.now(),
        userVersions: versions(m.id),
        lastMessageId: m.id,
      })
      if (m.role === 'user') continue
    }
    if (m.role !== 'assistant') continue
    const t = turns.at(-1)!
    if (t.lastMessageId === t.id) t.answerVersions = versions(m.id)
    t.lastMessageId = m.id
    const meta = m.metadata as Partial<TurnMetadata> | undefined
    t.assistantMessage += text(m)
    for (const call of m.parts.filter(isToolPart).map(toolCall)) {
      if (call.id in opts.viewStates) call.viewState = opts.viewStates[call.id]
      // files_cite only records citations; they show under the answer, not in the process list.
      const cited = call.name === 'files_cite' && (call.result?.structuredContent as { citations?: Citation[] } | undefined)?.citations
      if (cited) t.citations.push(...cited)
      const found = (call.result?.structuredContent as { sources?: WebSource[] } | undefined)?.sources
      if (found && call.name.startsWith('web_')) t.sources = dedupe([...(t.sources ?? []), ...found])
      t.toolCalls.push(call)
    }
    if (meta?.model) t.model = meta.model
    if (meta?.effort) t.effort = meta.effort
    if (meta?.createdAt) t.createdAt = meta.createdAt
  }

  for (const t of turns) t.summary = processSummary(t.toolCalls)

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
