// Developer mode's view of a conversation: every model request and tool run on the shown branch, in order, grouped
// by the turn that caused them. Built from the same pi-durable view as the transcript (lib/turns.ts); pi writes the
// system prompt and tool list into it as `pi.system` entries, so each request's context can be replayed here.
import { BRIEF_KIND, COMPACTION_KIND, EVENT_KIND, parseNote, RUN_ERROR_KIND } from '@gense/protocol'

type Part = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown; mimeType?: string }
type ToolDecl = { name: string; description?: string; parameters?: unknown }
type Message = {
  role: string
  content?: string | Part[]
  timestamp?: number
  provider?: string
  model?: string
  api?: string
  responseId?: string
  thinkingLevel?: string
  providerThinkingLevel?: string
  stopReason?: string
  errorMessage?: string
  usage?: Usage
  durationMs?: number
  toolCallId?: string
  toolName?: string
  isError?: boolean
  details?: unknown
  sections?: Record<string, string | null>
  toolsAdded?: ToolDecl[]
  toolsRemoved?: { name: string }[]
}
type Entry = { id: number; kind: string; data?: unknown; model?: Message[]; head?: number; conversationId?: number }
type View = { entries: Entry[]; docs: Record<string, unknown> }

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning?: number
  totalTokens: number
  cost?: { total?: number }
}

/** What the model saw for one request: the prompt sections and tools in effect, and how many messages followed them. */
export interface CallContext {
  sections: [key: string, text: string][]
  tools: ToolDecl[]
  /** User, assistant and tool messages in context before this request, since the last compaction or reset. */
  messages: number
}

export interface ModelStep {
  kind: 'model'
  /** Entry id; `live` for the request still streaming. */
  id: string
  /** 1-based, across the branch. */
  n: number
  provider: string
  model: string
  api?: string
  responseId?: string
  thinkingLevel?: string
  stopReason?: string
  error?: string
  usage?: Usage
  start: number
  durationMs?: number
  output: Part[]
  context: CallContext
  live?: boolean
  raw: unknown
}

export interface ToolStep {
  kind: 'tool'
  id: string
  callId: string
  name: string
  input: unknown
  output: string
  isError: boolean
  /** Started at; the result's timestamp is when the run ended. */
  start?: number
  durationMs?: number
  raw: unknown
}

export interface SystemStep {
  kind: 'system'
  id: string
  at?: number
  /** Section keys set (added or changed) and removed. */
  set: string[]
  removed: string[]
  toolsAdded: string[]
  toolsRemoved: string[]
  /** The first prompt of the context, or the one after a compaction: everything is restated. */
  baseline: boolean
  raw: unknown
}

export interface NoteStep {
  kind: 'note'
  id: string
  at?: number
  tone: 'info' | 'error'
  text: string
  raw: unknown
}

export type TraceStep = ModelStep | ToolStep | SystemStep | NoteStep

export interface TraceTurn {
  /** Same id as the transcript's turn (lib/turns.ts), so the two can point at each other. */
  id: string
  label: string
  at?: number
  steps: TraceStep[]
}

export interface TraceTotals {
  calls: number
  tools: number
  failedTools: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  cost: number
  modelMs: number
  toolMs: number
}

export interface Trace {
  turns: TraceTurn[]
  totals: TraceTotals
}

const parts = (content: Message['content']): Part[] => (typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? []))
const textOf = (content: Message['content']) =>
  parts(content)
    .map((p) => (p.type === 'text' ? (p.text ?? '') : p.type === 'image' ? `[图片 ${p.mimeType ?? ''}]` : ''))
    .join('')

/** The first line of a user message without the app's note blocks (protocol `notes.ts`). */
function firstLine(content: Message['content']) {
  const text = parts(content)
    .filter((p) => p.type === 'text' && !parseNote(p.text ?? ''))
    .map((p) => p.text ?? '')
    .join('')
    .trim()
  return text.split('\n')[0] ?? ''
}

export const emptyTotals = (): TraceTotals => ({ calls: 0, tools: 0, failedTools: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, modelMs: 0, toolMs: 0 })

export function addTotals(t: TraceTotals, step: TraceStep) {
  if (step.kind === 'model') {
    t.calls++
    const u = step.usage
    if (u) {
      t.input += u.input
      t.output += u.output
      t.cacheRead += u.cacheRead
      t.cacheWrite += u.cacheWrite
      t.reasoning += u.reasoning ?? 0
      t.cost += u.cost?.total ?? 0
    }
    t.modelMs += step.durationMs ?? 0
  } else if (step.kind === 'tool') {
    t.tools++
    if (step.isError) t.failedTools++
    t.toolMs += step.durationMs ?? 0
  }
  return t
}

/** Projects the view of the shown branch onto turns of model requests and tool runs. */
export function toTrace(view: View): Trace {
  const turns: TraceTurn[] = []
  const sections = new Map<string, string>()
  const tools = new Map<string, ToolDecl>()
  // Context messages since the last head marker (compaction or reset); a head marker also means the next system entry
  // restates the whole prompt.
  let messages = 0
  let rebase = true
  let n = 0

  const open = (id: string, label: string, at?: number) => {
    const t: TraceTurn = { id, label, at, steps: [] }
    turns.push(t)
    return t
  }
  const current = () => turns.at(-1) ?? open('start', '开始', undefined)
  const context = (): CallContext => ({ sections: [...sections], tools: [...tools.values()], messages })

  const modelStep = (id: string, m: Message, raw: unknown, live = false): ModelStep => ({
    kind: 'model',
    id,
    n: ++n,
    provider: m.provider ?? '',
    model: m.model ?? '',
    api: m.api,
    responseId: m.responseId,
    thinkingLevel: m.providerThinkingLevel ?? m.thinkingLevel,
    stopReason: m.stopReason,
    error: m.errorMessage,
    usage: m.usage,
    start: m.timestamp ?? 0,
    durationMs: m.durationMs,
    output: parts(m.content),
    context: context(),
    ...(live && { live }),
    raw,
  })

  for (const e of view.entries) {
    const m = e.model?.[0]
    if (e.head !== undefined && e.kind !== 'pi.system') {
      // The context restarts at `head`: count only what is kept from there.
      messages = view.entries.filter((x) => x.id >= e.head! && x.id <= e.id && x.kind !== 'pi.system' && x.model?.length).length
      rebase = true
    }
    if (e.kind === 'pi.user' || e.kind === EVENT_KIND || e.kind === BRIEF_KIND) {
      const label =
        e.kind === EVENT_KIND ? `事件：${(e.data as { title?: string } | undefined)?.title ?? ''}` : e.kind === BRIEF_KIND ? ((e.data as { label?: string } | undefined)?.label ?? '') : firstLine(m?.content)
      open(String(e.id), label || '（空消息）', m?.timestamp)
      messages++
    } else if (e.kind === 'pi.system' && m) {
      const baseline = rebase
      if (rebase) {
        sections.clear()
        tools.clear()
        rebase = false
      }
      const set: string[] = []
      const removed: string[] = []
      for (const [k, v] of Object.entries(m.sections ?? {}))
        if (v === null) {
          sections.delete(k)
          removed.push(k)
        } else {
          sections.delete(k) // re-adding appends, as pi replays it
          sections.set(k, v)
          set.push(k)
        }
      for (const t of m.toolsRemoved ?? []) tools.delete(t.name)
      for (const t of m.toolsAdded ?? []) {
        tools.delete(t.name)
        tools.set(t.name, t)
      }
      current().steps.push({ kind: 'system', id: String(e.id), at: m.timestamp, set, removed, toolsAdded: (m.toolsAdded ?? []).map((t) => t.name), toolsRemoved: (m.toolsRemoved ?? []).map((t) => t.name), baseline, raw: e })
    } else if (e.kind === 'pi.assistant' && m) {
      current().steps.push(modelStep(String(e.id), m, e))
      messages++
    } else if (e.kind === 'pi.tool-result' && m) {
      const call = current()
        .steps.flatMap((s) => (s.kind === 'model' ? s.output : []))
        .find((p) => p.type === 'toolCall' && p.id === m.toolCallId)
      const step: ToolStep = {
        kind: 'tool',
        id: String(e.id),
        callId: m.toolCallId ?? '',
        name: m.toolName ?? call?.name ?? 'tool',
        input: call?.arguments ?? {},
        output: textOf(m.content),
        isError: !!m.isError,
        start: m.timestamp !== undefined && m.durationMs !== undefined ? m.timestamp - m.durationMs : m.timestamp,
        durationMs: m.durationMs,
        raw: e,
      }
      current().steps.push(step)
      messages++
    } else if (e.kind === COMPACTION_KIND) {
      current().steps.push({ kind: 'note', id: String(e.id), at: m?.timestamp, tone: 'info', text: `上下文已压缩（${(e.data as { reason?: string } | undefined)?.reason ?? 'manual'}），从第 ${e.head ?? '?'} 条记录起保留`, raw: e })
    } else if (e.kind === RUN_ERROR_KIND) {
      const d = (e.data ?? {}) as { reason?: string; detail?: string }
      current().steps.push({ kind: 'note', id: String(e.id), at: m?.timestamp, tone: d.reason === 'aborted' ? 'info' : 'error', text: d.reason === 'aborted' ? '已停止' : `运行出错：${d.detail ?? d.reason ?? ''}`, raw: e })
    }
  }

  // The request being answered right now.
  const live = view.docs['pi.live'] as { run?: unknown; generation?: { message?: Message } } | undefined
  if (live?.run && live.generation?.message) current().steps.push(modelStep('live', live.generation.message, live.generation, true))

  const totals = emptyTotals()
  for (const t of turns) for (const s of t.steps) addTotals(totals, s)
  return { turns, totals }
}

/** When a step started and ended, for the waterfall; undefined when the entry has no timing. */
export function spanOf(step: TraceStep, now = Date.now()): { start: number; end: number } | undefined {
  if (step.kind === 'model') return step.start ? { start: step.start, end: step.start + (step.durationMs ?? (step.live ? now - step.start : 0)) } : undefined
  if (step.kind === 'tool') return step.start !== undefined ? { start: step.start, end: step.start + (step.durationMs ?? 0) } : undefined
  return undefined
}

/** The system prompt as the model received it: the sections in order, each as pi renders it. */
export const systemPromptText = (ctx: CallContext) => ctx.sections.map(([, text]) => text).join('\n\n')
