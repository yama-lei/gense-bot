// Messages that are not the user's own input (roadmap-3 D4: R46–R50): a branch's report, a schedule's tick, a webhook
// call. Each is an Event with a source, delivered to a branch of a tree, the main one by default, as an `app.event`
// entry the model reads as an <event> block. One that wakes the branch starts a run, or queues while it is busy; one
// that does not only lands in the transcript for its next turn.
import type { Context } from '@earendil-works/chord/context'
import { defineTask, defineTool, type ToolExecutionApi, type ToolRegistration } from '@earendil-works/pi-durable'
import { Type } from 'typebox'
import type { EventData, ScheduleRule } from './protocol.ts'

/** An Event before it has an id and a time. */
export type EventDraft = Omit<EventData, 'id' | 'createdAt'>

const escape = (s: string) => s.replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]!)

/** What the model reads for an Event. */
export const eventText = (e: EventData) =>
  `<event source="${e.source.kind}" from="${escape(e.source.label)}" type="${e.type}">\n${e.title}\n\n${e.body}\n</event>`

/** Asked of a user branch for "summarize to the main line" (R40); the answer goes to the main branch through `report`. */
export const SUMMARIZE_PROMPT =
  '请把这个分叉从分叉点到现在的内容整理成：目标、结论、关键决定、改过的文件、未解决的问题。然后调用 report 工具把它交给主线，title 写一句话的结论。'

// --- Schedules (R49) ---

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/** The wall-clock fields of `at` in `tz`. */
function wall(at: number, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(at)
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value)
  return { year: n('year'), month: n('month'), day: n('day'), hour: n('hour'), minute: n('minute'), second: n('second') }
}

/** The instant the clocks of `tz` show this date and time; in a gap of a DST change, the instant after it. */
function instant(year: number, month: number, day: number, hour: number, minute: number, tz: string) {
  const want = Date.UTC(year, month - 1, day, hour, minute)
  const offset = (at: number) => {
    const w = wall(at, tz)
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(at / 1000) * 1000
  }
  let at = want - offset(want)
  at = want - offset(at)
  return at
}

export function checkTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
  } catch {
    throw new Error(`未知的时区：${tz}`)
  }
}

/** Throws unless the rule can fire. */
export function checkRule(rule: ScheduleRule) {
  const time = (t: string) => {
    const m = /^(\d{2}):(\d{2})$/.exec(t)
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error('时间格式是 HH:MM')
  }
  if (rule.kind === 'once' && !Number.isFinite(rule.at)) throw new Error('需要执行时间')
  if (rule.kind === 'daily') time(rule.time)
  if (rule.kind === 'weekly') {
    time(rule.time)
    if (!rule.days.length || rule.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('请选择星期几')
  }
  if (rule.kind === 'interval' && !(Number.isInteger(rule.minutes) && rule.minutes >= 5)) throw new Error('间隔至少 5 分钟')
}

/** The first time after `after` that the rule fires, in epoch milliseconds; null when it fires no more. */
export function nextRun(rule: ScheduleRule, tz: string, after: number): number | null {
  switch (rule.kind) {
    case 'once':
      return rule.at > after ? rule.at : null
    case 'interval':
      return after + rule.minutes * MINUTE
    case 'daily':
    case 'weekly': {
      const [hour, minute] = rule.time.split(':').map(Number) as [number, number]
      const today = wall(after, tz)
      for (let i = 0; i <= 8; i++) {
        const date = new Date(Date.UTC(today.year, today.month - 1, today.day) + i * DAY)
        if (rule.kind === 'weekly' && !rule.days.includes(date.getUTCDay())) continue
        const at = instant(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, tz)
        if (at > after) return at
      }
      return null
    }
  }
}

/** What a schedule's task does when it fires: the next run, or null to stop. */
export type Fire = (scheduleId: string, at: number, ctx: Context) => Promise<number | null>

type ScheduleCheckpoint = { phase: 'fire'; at: number }

/**
 * A schedule's durable timer: a background task of the tree's main conversation that sleeps until the next run, fires,
 * and sleeps again. A firing is idempotent by schedule and time, so one repeated after a crash delivers once.
 */
export const scheduleTask = (fire: () => Fire) =>
  defineTask<{ scheduleId: string; at: number }, ScheduleCheckpoint, null>({
    name: 'app.schedule',
    version: 1,
    initial: ({ at }) => ({ phase: 'fire', at }),
    phases: {
      async fire(task, runtime, ctx) {
        const { at } = task.state.checkpoint
        if (runtime.now() < at) return runtime.sleepUntil(at, { phase: 'fire', at }, ctx)
        const next = await fire()(task.input.scheduleId, at, ctx)
        if (next === null) return runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), ctx)
        await runtime.sleepUntil(next, { phase: 'fire', at: next }, ctx)
      },
    },
    async abort(_task, runtime, ctx) {
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted', reason: 'schedule removed' } }), ctx)
    },
  })

// --- Webhooks (R50) ---

/** Webhooks are served at `/hooks/<userId>/<hookId>`, outside the session-checked paths. */
export const hooksPath = (userId: string) => `/hooks/${userId}`

/** The user and webhook a request path names, if it is a webhook path. */
export function parseHookPath(path: string) {
  const m = /^\/hooks\/([\w-]{1,64})\/([\w-]{1,64})$/.exec(path)
  return m ? { userId: m[1]!, hookId: m[2]! } : undefined
}

/** How old a signed timestamp may be, either way. */
export const WEBHOOK_SKEW_S = 300
export const WEBHOOK_MAX_BODY = 64 * 1024

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')

export async function hmac(secret: string, message: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)))
}

/** Whether `signature` (`sha256=<hex>`) signs `${timestamp}.${body}` with `secret`, at a time near `now`. */
export async function verifySignature(secret: string, timestamp: string | null, signature: string | null, body: string, now: number) {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false
  if (Math.abs(now / 1000 - Number(timestamp)) > WEBHOOK_SKEW_S) return false
  const want = `sha256=${await hmac(secret, `${timestamp}.${body}`)}`
  if (want.length !== signature.length) return false
  let diff = 0
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ signature.charCodeAt(i)
  return diff === 0
}

/** A webhook call's title and text: `{ title, text }` JSON, or the raw body. */
export function webhookContent(body: string, contentType: string | null) {
  if (contentType?.includes('json')) {
    try {
      const value = JSON.parse(body) as { title?: unknown; text?: unknown }
      if (value && typeof value === 'object' && (typeof value.title === 'string' || typeof value.text === 'string'))
        return { title: typeof value.title === 'string' && value.title.trim() ? value.title.trim() : 'Webhook', body: typeof value.text === 'string' ? value.text : '' }
      return { title: 'Webhook', body: '```json\n' + JSON.stringify(value, null, 2) + '\n```' }
    } catch {
      // Not JSON after all: the raw body.
    }
  }
  return { title: 'Webhook', body }
}

// --- Subagents (R51–R56) ---

/** How many subagents of one tree may run at once. */
export const MAX_AGENTS = 3

/** The brief a subagent starts from (D3); the faux model recognizes it. */
export const agentBrief = (title: string, task: string) =>
  `你是子 agent「${title}」。任务：\n${task}\n\n完成后必须调用 report 工具把结果交给主线（title 写一句话的结论，body 写详细结果）；你不能调用 agent_spawn。`

export type AgentInput = { treeId: string; branchId: string; conversationId: number; title: string; task: string }
/** How a subagent's run ended. */
export type AgentEnd = { status: 'done' | 'unanswered'; reason?: string }
type AgentCheckpoint = { phase: 'run' } | { phase: 'finish'; end: AgentEnd }

/**
 * A subagent's anchor: a background task of the main conversation that gives the subagent its brief, waits for that run
 * to end, and reports for it when it did not report itself (R53). Its submission has a fixed request id, so a rerun after
 * a restart waits for the same run, and the unreported notice has a fixed key, so it is sent once (V6).
 */
export const agentTask = (agents: () => { run: (input: AgentInput, ctx: Context) => Promise<AgentEnd>; finish: (input: AgentInput, end: AgentEnd, ctx: Context) => Promise<void> }) =>
  defineTask<AgentInput, AgentCheckpoint, null>({
    name: 'app.agent',
    version: 1,
    initial: () => ({ phase: 'run' }),
    phases: {
      async run(task, runtime, ctx) {
        const end = await agents().run(task.input, ctx)
        await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'finish', end } }), ctx)
      },
      async finish(task, runtime, ctx) {
        await agents().finish(task.input, task.state.checkpoint.end, ctx)
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), ctx)
      },
    },
    // Only the tree's removal aborts the anchor; stopping the subagent itself ends its run, which `run` sees.
    async abort(_task, runtime, ctx) {
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted', reason: 'tree removed' } }), ctx)
    },
  })

export type Spawn = (api: ToolExecutionApi, args: { task: string; title: string; mode: 'fork' | 'new' }, ctx: Context) => Promise<string>

export const spawnTool = (spawn: () => Spawn) =>
  defineTool({
    name: 'agent_spawn',
    description:
      `Start a subagent that works on a self-contained task in the background, in its own branch of this conversation tree, and reports its result back with \`report\`. Returns at once: tell the user what you started and do not wait; each report arrives later as an <event> and wakes you. At most ${MAX_AGENTS} subagents run at once; only the main line can spawn, and subagents cannot spawn their own.`,
    parameters: Type.Object({
      task: Type.String({ description: 'Everything the subagent needs to know to do the task and what to report' }),
      title: Type.String({ description: 'A short name for the subagent, shown to the user' }),
      mode: Type.Optional(
        Type.Union([Type.Literal('fork'), Type.Literal('new')], {
          description: '`fork` (default): the subagent knows this conversation so far. `new`: it sees only the task',
        }),
      ),
    }),
    // Not rerun after a crash: a second spawn would start a second subagent. The model sees the call was interrupted.
    replay: 'unsafe',
    async execute({ task, title, mode }, api, ctx) {
      const text = await spawn()(api as ToolExecutionApi, { task, title, mode: mode ?? 'fork' }, ctx)
      return { output: [{ type: 'text', text }] }
    },
  }) as unknown as ToolRegistration

// --- report (R40, R52) ---

/** Where a `report` from a conversation goes; throws when it has nowhere to go. */
export type Report = (conversationId: number, report: { title: string; body: string }, ctx: Context) => Promise<string>

export const reportTool = (report: () => Report) =>
  defineTool({
    name: 'report',
    description:
      'Hand a result to the main line of this conversation tree. Use it in a branch when the user asks to summarize the branch for the main line, or when your task in the branch is done. Not available on the main line itself.',
    parameters: Type.Object({
      title: Type.String({ description: 'One sentence: the conclusion' }),
      body: Type.String({ description: 'The summary in Markdown' }),
    }),
    async execute({ title, body }, api, ctx) {
      const text = await report()(api.conversationId, { title, body }, ctx)
      return { output: [{ type: 'text', text }] }
    },
  }) as unknown as ToolRegistration
