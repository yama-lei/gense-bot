// Projects a pi-durable conversation view onto the UI's turns: a user entry opens a turn and the assistant and tool
// entries after it fill it. `pi.live` adds the streaming answer, `pi.inbox` the inputs still waiting. An Event (R46) or a
// request the app made for the user (R40) opens a turn too, shown as a card instead of the user's message.
import { BRIEF_KIND, EVENT_KIND, RUN_ERROR_KIND, parseNote, type BriefData, type EventData, type Mention, type RunErrorData } from '@gense/protocol'
import { baseName } from './format'
import type { Attachment, CommandRef, ToolCall, Turn, WebSource } from './types'

type Part = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown }
type Message = {
  role: string
  content: string | Part[]
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
export type Entry = { id: number; conversationId?: number; kind: string; data?: unknown; model?: Message[] }
type Live = { run?: unknown; generation?: { message?: Message; retry?: { error: string } } }
type Inbox = { items?: { id: number; mode: string; content?: unknown; entry?: { kind: string; data?: unknown } }[] }
export type View = { entries: Entry[]; docs: Record<string, unknown> }

const parts = (content: Message['content'] | undefined): Part[] => (typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? []))
const textOf = (content: Message['content'] | undefined) =>
  parts(content)
    .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
    .join('')

/** A user message's own text, and the attachments, command and mentions of its note blocks (protocol `notes.ts`). */
function userInput(content: unknown) {
  let text = ''
  const attachments: Attachment[] = []
  let command: CommandRef | undefined
  const mentions: Mention[] = []
  for (const b of parts(Array.isArray(content) || typeof content === 'string' ? (content as Message['content']) : undefined)) {
    if (b.type !== 'text') continue
    const note = parseNote(b.text ?? '')
    if (!note) {
      text += b.text ?? ''
      continue
    }
    for (const path of note.attachments) attachments.push({ id: path, name: baseName(path) })
    command ??= note.command
    mentions.push(...note.mentions)
  }
  return { text, attachments, command, mentions }
}

function withInput(turn: Turn, input: ReturnType<typeof userInput>) {
  if (input.attachments.length) turn.attachments = input.attachments
  if (input.command) turn.command = input.command
  if (input.mentions.length) turn.mentions = input.mentions
  return turn
}

const reasonText: Record<string, string> = { stale: '服务重启，这条消息没有完成', aborted: '已停止' }

export function toTurns(view: View): Turn[] {
  const turns: Turn[] = []
  const calls = new Map<string, ToolCall>()
  // Where the last assistant entry's blocks start, while it ended `aborted`: a restart asks the model again, and the
  // new answer replaces the cut-off one.
  let abortedFrom: { blocks: number; text: number } | undefined
  const open = (id: string, userMessage: string, createdAt: number): Turn => {
    const turn: Turn = { id, status: 'succeeded', userMessage, assistantMessage: '', blocks: [], sources: [], createdAt }
    turns.push(turn)
    abortedFrom = undefined
    return turn
  }
  const current = (at: number) => turns.at(-1) ?? open(`start-${at}`, '', at)
  const cut = (t: Turn) => {
    if (!abortedFrom) return
    t.blocks.length = abortedFrom.blocks
    t.assistantMessage = t.assistantMessage.slice(0, abortedFrom.text)
  }
  /** Appends an assistant message's parts; `seen` skips tool calls the transcript already has. */
  const append = (t: Turn, m: Message) => {
    for (const b of parts(m.content)) {
      if (b.type === 'text' && b.text) {
        t.blocks.push({ kind: 'text', text: b.text })
        t.assistantMessage += (t.assistantMessage ? '\n\n' : '') + b.text
      } else if (b.type === 'thinking' && b.thinking?.trim()) {
        t.blocks.push({ kind: 'thinking', text: b.thinking })
      } else if (b.type === 'toolCall' && b.id && !calls.has(b.id)) {
        const call: ToolCall = { id: b.id, name: b.name ?? 'tool', status: 'running', input: b.arguments ?? {} }
        calls.set(b.id, call)
        t.blocks.push({ kind: 'tool', call })
      }
    }
  }

  let previous: Entry | undefined
  for (const e of view.entries) {
    const m = e.model?.[0]
    if (e.kind === 'pi.user') {
      const input = userInput(m?.content)
      const turn = withInput(open(String(e.id), input.text, m?.timestamp ?? Date.now()), input)
      turn.anchor = previous ? String(previous.id) : 'start'
      if (e.conversationId !== undefined) turn.writer = e.conversationId
    } else if (e.kind === EVENT_KIND) {
      open(String(e.id), '', m?.timestamp ?? Date.now()).event = e.data as EventData
    } else if (e.kind === BRIEF_KIND) {
      open(String(e.id), '', m?.timestamp ?? Date.now()).brief = (e.data as BriefData | undefined)?.label ?? ''
    } else if (e.kind === 'pi.assistant' && m) {
      const t = current(e.id)
      if (abortedFrom) {
        cut(t)
        t.status = 'succeeded'
        t.error = undefined
      }
      abortedFrom = m.stopReason === 'aborted' ? { blocks: t.blocks.length, text: t.assistantMessage.length } : undefined
      append(t, m)
      if (m.provider && m.model) t.model = `${m.provider}:${m.model}`
      if (m.stopReason === 'error') Object.assign(t, { status: 'failed', error: m.errorMessage || '模型请求失败' })
      if (m.stopReason === 'aborted') t.status = 'interrupted'
    } else if (e.kind === 'pi.tool-result' && m) {
      const t = turns.at(-1)
      const call = m.toolCallId ? calls.get(m.toolCallId) : undefined
      if (call) {
        call.status = m.isError ? 'failed' : 'succeeded'
        call.result = { content: textOf(m.content), isError: !!m.isError, ...(m.details !== undefined && { structuredContent: m.details }) }
        call.durationMs = m.durationMs
      }
      // Web tools list the pages they used; the turn shows them once each.
      const found = (m.details as { sources?: WebSource[] } | undefined)?.sources
      if (t && Array.isArray(found)) for (const src of found) if (src?.url && !t.sources.some((x) => x.url === src.url)) t.sources.push(src)
    } else if (e.kind === RUN_ERROR_KIND) {
      const t = current(e.id)
      const { reason, detail } = (e.data ?? {}) as Partial<RunErrorData>
      if (reason === 'aborted') t.status = 'interrupted'
      else if (t.status !== 'failed') Object.assign(t, { status: 'failed', error: reasonText[reason ?? ''] ?? detail ?? reason ?? '请求失败' })
    }
    if (turns.length) turns.at(-1)!.lastEntryId = e.id
    previous = e
  }

  const live = view.docs['pi.live'] as Live | undefined
  const last = turns.at(-1)
  if (live?.run && last) {
    last.status = 'running'
    last.error = undefined
    cut(last)
    // The answer being written; pi-ai parses tool arguments as they stream (R72).
    if (live.generation?.message) append(last, live.generation.message)
    if (live.generation?.retry) last.error = live.generation.retry.error
  }
  for (const t of turns)
    if (t.status !== 'running')
      for (const b of t.blocks)
        if (b.kind === 'tool' && b.call.status === 'running') Object.assign(b.call, { status: 'failed', result: { content: '未完成', isError: true } })

  const inbox = view.docs['pi.inbox'] as Inbox | undefined
  for (const item of inbox?.items ?? [])
    if (item.entry?.kind === EVENT_KIND || item.entry?.kind === BRIEF_KIND) {
      const turn = open(`queued-${item.id}`, '', Date.now())
      if (item.entry.kind === EVENT_KIND) turn.event = item.entry.data as EventData
      else turn.brief = (item.entry.data as BriefData | undefined)?.label ?? ''
      turn.status = 'queued'
    } else if (item.mode !== 'write') {
      const input = userInput(item.content)
      withInput(open(`queued-${item.id}`, input.text, Date.now()), input).status = 'queued'
    }
  return turns
}
