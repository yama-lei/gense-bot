// Projects a pi-durable conversation view onto the UI's turns: a user entry opens a turn and the assistant and tool
// entries after it fill it. `pi.live` adds the streaming answer, `pi.inbox` the inputs still waiting.
import { RUN_ERROR_KIND, type RunErrorData } from '@gense/core/protocol'
import { tools } from '../plugins'
import type { Attachment, Effort, ToolCall, Turn, WebSource } from '../types'

type Block = { type: string; text?: string; id?: string; name?: string; arguments?: unknown }
type Message = {
  role: string
  content: string | Block[]
  timestamp?: number
  provider?: string
  model?: string
  stopReason?: string
  errorMessage?: string
  toolCallId?: string
  isError?: boolean
  durationMs?: number
  details?: unknown
}
export type Entry = { id: number; kind: string; data?: unknown; model?: Message[] }
type Live = { run?: unknown; generation?: { message?: Message; retry?: { error: string } } }
type Inbox = { items?: { id: number; mode: string; content?: unknown }[] }
export type View = { entries: Entry[]; docs: Record<string, unknown> }

const textOf = (content: Message['content'] | undefined) =>
  typeof content === 'string' ? content : (content ?? []).map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('')

const inputText = (content: unknown) =>
  typeof content === 'string' ? content : Array.isArray(content) ? textOf(content as Block[]) : ''

/** A user message's text and the workspace paths of its attachments (see core `attachmentsText`). */
const userInput = (content: Message['content'] | undefined) => {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : ((content ?? []) as Block[])
  let text = ''
  const attachments: Attachment[] = []
  for (const b of blocks) {
    if (b.type !== 'text') continue
    const listed = /^<attachments>\n([\s\S]*)\n<\/attachments>$/.exec(b.text ?? '')
    if (!listed) text += b.text ?? ''
    else for (const path of listed[1]!.split('\n')) attachments.push({ id: path, name: path.slice(path.lastIndexOf('/') + 1), mimeType: '', size: null })
  }
  return { text, attachments }
}

const reasonText: Record<string, string> = { stale: '服务重启，这条消息没有完成', aborted: '已停止' }

export function toTurns(view: View, defaults: { model: string; effort: Effort }): Turn[] {
  const turns: Turn[] = []
  // Where the last assistant entry's text starts, while it ended `aborted`: a restart re-asks the model, and the new
  // answer replaces the cut-off one.
  let abortedFrom: number | undefined
  const open = (id: string, userMessage: string, createdAt: number): Turn => {
    const turn: Turn = { id, requestId: id, status: 'succeeded', userMessage, assistantMessage: '', toolCalls: [], citations: [], ...defaults, createdAt }
    turns.push(turn)
    abortedFrom = undefined
    return turn
  }
  const current = (at: number) => turns.at(-1) ?? open(`start-${at}`, '', at)

  for (const e of view.entries) {
    const m = e.model?.[0]
    if (e.kind === 'pi.user') {
      const input = userInput(m?.content)
      const turn = open(String(e.id), input.text, m?.timestamp ?? Date.now())
      if (input.attachments.length) turn.attachments = input.attachments
    } else if (e.kind === 'pi.assistant' && m) {
      const t = current(e.id)
      if (abortedFrom !== undefined) {
        t.assistantMessage = t.assistantMessage.slice(0, abortedFrom)
        t.status = 'succeeded'
        t.error = undefined
      }
      const text = textOf(m.content)
      abortedFrom = m.stopReason === 'aborted' ? t.assistantMessage.length : undefined
      t.assistantMessage += (t.assistantMessage && text ? '\n\n' : '') + text
      if (m.provider && m.model) t.model = `${m.provider}:${m.model}`
      for (const b of typeof m.content === 'string' ? [] : m.content)
        if (b.type === 'toolCall' && b.id) t.toolCalls.push({ id: b.id, name: b.name ?? 'tool', status: 'running', input: b.arguments ?? {}, origin: 'model', resourceUri: tools[b.name ?? '']?.resourceUri })
      if (m.stopReason === 'error') Object.assign(t, { status: 'failed', error: m.errorMessage || '模型请求失败' })
      if (m.stopReason === 'aborted') t.status = 'interrupted'
    } else if (e.kind === 'pi.tool-result' && m) {
      const t = turns.at(-1)
      const call = t?.toolCalls.find((c) => c.id === m.toolCallId)
      if (call) {
        const result = { content: textOf(m.content), isError: !!m.isError, ...(m.details !== undefined && { structuredContent: m.details }) }
        Object.assign(call, { status: m.isError ? 'failed' : 'succeeded', result, durationMs: m.durationMs } satisfies Partial<ToolCall>)
      }
      // Web tools list the pages they used; the turn shows them once each.
      const found = (m.details as { sources?: WebSource[] } | undefined)?.sources
      if (t && Array.isArray(found))
        for (const src of found) if (!t.sources?.some((x) => x.url === src.url)) (t.sources ??= []).push(src)
    } else if (e.kind === RUN_ERROR_KIND) {
      const t = current(e.id)
      const { reason, detail } = (e.data ?? {}) as Partial<RunErrorData>
      if (reason === 'aborted') t.status = 'interrupted'
      else if (t.status !== 'failed') Object.assign(t, { status: 'failed', error: reasonText[reason ?? ''] ?? detail ?? reason ?? '请求失败' })
    }
  }

  const live = view.docs['pi.live'] as Live | undefined
  const last = turns.at(-1)
  if (live?.run && last) {
    last.status = 'running'
    last.error = undefined
    const partial = textOf(live.generation?.message?.content)
    if (abortedFrom !== undefined) last.assistantMessage = last.assistantMessage.slice(0, abortedFrom)
    if (partial) last.assistantMessage += (last.assistantMessage ? '\n\n' : '') + partial
  }
  for (const t of turns)
    if (t.status !== 'running') t.toolCalls = t.toolCalls.map((c) => (c.status === 'running' ? { ...c, status: 'failed', result: { content: '未完成', isError: true } } : c))

  const inbox = view.docs['pi.inbox'] as Inbox | undefined
  for (const item of inbox?.items ?? [])
    if (item.mode !== 'write') Object.assign(open(`queued-${item.id}`, inputText(item.content), Date.now()), { status: 'queued' })
  return turns
}
