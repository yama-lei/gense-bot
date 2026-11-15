import type { EventData, FeedbackReason, MemoryToolDetails, ModelInfo, NativeSource, NativeStep } from '@gense/protocol'
import { FEEDBACK_REASONS, MEMORY_LIMITS } from '@gense/protocol'
import {
  BookmarkPlus,
  Bot,
  BookOpen,
  Brain,
  Check,
  CornerDownRight,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Ellipsis,
  FileText,
  FolderOpen,
  GitBranch,
  Globe,
  ImageIcon,
  Info,
  MessageSquare,
  PencilLine,
  Puzzle,
  Radio,
  RefreshCw,
  ScanText,
  Search,
  ShieldAlert,
  Slash,
  Square,
  ThumbsDown,
  ThumbsUp,
  Undo2,
  Volume2,
  Webhook,
  Wrench,
  X,
} from 'lucide-react'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { modelKey, report, useClient, useHost, type Client } from '../../app/client'
import { cn } from '../../lib/cn'
import { copyText, formatBytes, formatDuration, formatTime } from '../../lib/format'
import { useFlash } from '../../lib/hooks'
import { Link } from '../../lib/router'
import type { ToolIndex, ToolMeta } from '../../lib/tools'
import type { ToolCall, Turn, TurnBlock, Versions, WebSource } from '../../lib/types'
import type { DisplayMode } from '../../plugins/types'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Notice, Spinner } from '../../ui/feedback'
import { Textarea } from '../../ui/input'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Popover, PopoverContent, PopoverTrigger } from '../../ui/menu'
import { Tooltip } from '../../ui/tooltip'
import { CompactionDivider } from './Compaction'
import { Markdown } from './Markdown'
import { useCanSpeak, useSpeech } from './speech'
import { hasView, ViewSlot } from './ViewSlot'

export interface TurnContext {
  treeId: string
  tools: ToolIndex
  models: ModelInfo[]
  /** A turn is running: versions stay put and history cannot branch until it settles. */
  busy: boolean
  onRegenerate: (turn: Turn) => void
  onEdit: (turn: Turn, text: string) => void
  onFork: (turn: Turn) => void
  onShowBranch: (branchId: string) => void
  onSend: (text: string) => void
  /** Opens a call's view in the side panel, or brings it back inline. */
  onDisplayMode: (call: ToolCall, mode: DisplayMode) => void
  /** The call whose view is in the side panel now. */
  panelCallId?: string
}

type Step = Exclude<TurnBlock, { kind: 'text' }>
type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'steps'; steps: Step[] }
  | { kind: 'view'; call: ToolCall; meta: ToolMeta }
  | { kind: 'memory'; call: ToolCall; details: MemoryToolDetails }

/** An answer in the order it was produced: prose, runs of thinking and tool calls folded together, and views. */
function segments(blocks: TurnBlock[], tools: ToolIndex): Segment[] {
  const out: Segment[] = []
  for (const b of blocks) {
    if (b.kind === 'text') {
      if (b.text.trim()) out.push({ kind: 'text', text: b.text })
      continue
    }
    if (b.kind === 'thinking' && !b.text.trim()) continue
    // A memory the model saved, corrected or removed shows in the answer with an undo (roadmap-7 A3).
    const details = b.kind === 'tool' && b.call.name === 'memory' && !b.call.result?.isError ? (b.call.result?.structuredContent as MemoryToolDetails | undefined) : undefined
    if (b.kind === 'tool' && details?.memory) {
      out.push({ kind: 'memory', call: b.call, details })
      continue
    }
    const meta = b.kind === 'tool' ? tools.get(b.call.name) : undefined
    if (b.kind === 'tool' && meta && hasView(b.call, meta)) {
      out.push({ kind: 'view', call: b.call, meta })
      continue
    }
    const last = out.at(-1)
    if (last?.kind === 'steps') last.steps.push(b)
    else out.push({ kind: 'steps', steps: [b] })
  }
  return out
}

/** `last` is the newest turn of the conversation: it alone offers follow-ups. */
export function TurnView({ turn, ctx, last: newest }: { turn: Turn; ctx: TurnContext; last?: boolean }) {
  const client = useClient()
  const { prefs, suggestions } = useHost()
  // Follow-ups the server wrote for this answer (roadmap-7 D2); none while they are off or not generated yet.
  const followUps = newest && prefs?.suggestions !== false && suggestions[ctx.treeId]?.turnId === turn.id ? suggestions[ctx.treeId]!.items : []
  const active = turn.status === 'queued' || turn.status === 'running'
  // An Event or a brief is not the user's message: it has no versions to edit or ask again.
  const own = !turn.event && turn.brief === undefined
  const canChange = !ctx.busy && own
  const parts = segments(turn.blocks, ctx.tools)
  const canSpeak = useCanSpeak()
  // An Event that did not wake the conversation has no answer of its own; the next turn reads it.
  const passive = !!turn.event && parts.length === 0 && turn.status === 'succeeded'
  const model = turn.model ? (ctx.models.find((m) => modelKey(m) === turn.model)?.name ?? turn.model.slice(turn.model.indexOf(':') + 1)) : ''

  return (
    <section className="flex scroll-mt-4 flex-col gap-5" data-turn={turn.id}>
      {turn.event ? (
        <EventCard event={turn.event} queued={turn.status === 'queued'} />
      ) : turn.brief !== undefined ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <GitBranch className="size-4" /> {turn.brief}
        </div>
      ) : (
        <UserMessage turn={turn} versions={turn.versions} busy={ctx.busy} onShow={ctx.onShowBranch} onEdit={canChange ? (text) => ctx.onEdit(turn, text) : undefined} />
      )}

      {!passive && (
        <div className="flex min-w-0 flex-col gap-3">
          {turn.status === 'queued' && <Working label="排队中" />}
          {turn.status === 'running' && parts.length === 0 && !turn.refusal && <Working label="正在思考" />}
          {parts.map((s, i) => {
            const last = i === parts.length - 1
            if (s.kind === 'text') return <Markdown key={i} text={s.text} streaming={last && turn.status === 'running'} />
            if (s.kind === 'memory') return <MemoryChip key={s.call.id} details={s.details} />
            if (s.kind === 'steps') return <Steps key={i} steps={s.steps} tools={ctx.tools} live={last && turn.status === 'running'} />
            if (ctx.panelCallId === s.call.id)
              return (
                <button
                  key={s.call.id}
                  type="button"
                  className="self-start rounded-lg bg-muted px-3 py-1.5 text-sm text-muted-foreground hover:bg-hover"
                  onClick={() => ctx.onDisplayMode(s.call, 'inline')}
                >
                  已在侧边打开 · 点此收回
                </button>
              )
            return (
              <ViewSlot key={s.call.id} treeId={ctx.treeId} call={s.call} meta={s.meta} displayMode="inline" onDisplayMode={(mode) => ctx.onDisplayMode(s.call, mode)} onSend={ctx.onSend} />
            )
          })}
          {/* The model is working but the last thing on screen is finished: say that something is still coming. */}
          {turn.status === 'running' && parts.at(-1)?.kind === 'view' && <Working label="继续中" />}

          {turn.refusal && (
            <div className="flex items-start gap-2.5 rounded-2xl border bg-card px-3.5 py-3 text-sm">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="font-medium">这个问题我没法回答</div>
                <p className="mt-0.5 text-muted-foreground">DeepSeek 的安全检查拦下了这次提问。重新回答也会得到同样的结果，可以换个问法，或换一个模型。</p>
              </div>
            </div>
          )}
          {turn.status === 'failed' && (
            <Notice
              tone="error"
              title="这次回答没有完成"
              action={
                canChange && (
                  <Button size="sm" onClick={() => ctx.onRegenerate(turn)}>
                    <RefreshCw /> 重试
                  </Button>
                )
              }
            >
              {turn.error}
            </Notice>
          )}
          {turn.status === 'interrupted' && (
            <Notice
              tone="warning"
              title="已停止"
              action={
                canChange && (
                  <Button size="sm" onClick={() => ctx.onRegenerate(turn)}>
                    <RefreshCw /> 重新回答
                  </Button>
                )
              }
            >
              已经写出的内容保留，未完成的工具调用不会自动重跑。
            </Notice>
          )}

          {!active && (
            <div className="-ml-1.5 flex flex-wrap items-center gap-0.5 text-muted-foreground">
              {turn.assistantMessage && <CopyButton text={turn.assistantMessage} />}
              {turn.assistantMessage && own && <Feedback treeId={ctx.treeId} turnId={turn.id} />}
              {turn.assistantMessage && canSpeak && <ReadAloud id={turn.id} text={turn.assistantMessage} />}
              {canChange && (
                <Tooltip label="重新回答">
                  <Button variant="ghost" size="icon-sm" aria-label="重新回答" onClick={() => ctx.onRegenerate(turn)}>
                    <RefreshCw />
                  </Button>
                </Tooltip>
              )}
              <DropdownMenu>
                <Tooltip label="更多">
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label="更多">
                      <Ellipsis />
                    </Button>
                  </DropdownMenuTrigger>
                </Tooltip>
                <DropdownMenuContent align="start" className="w-52">
                  {turn.lastEntryId !== undefined && (
                    <DropdownMenuItem disabled={ctx.busy} onSelect={() => ctx.onFork(turn)}>
                      <GitBranch /> 从这里分叉
                    </DropdownMenuItem>
                  )}
                  {turn.assistantMessage && (
                    <DropdownMenuItem onSelect={() => remember(client, turn.assistantMessage, ctx.treeId)}>
                      <BookmarkPlus /> 存入记忆
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <div className="px-2.5 py-1.5 text-xs text-muted-foreground">
                    {model && <div className="truncate">{model}</div>}
                    <div>{new Date(turn.createdAt).toLocaleString()}</div>
                  </div>
                </DropdownMenuContent>
              </DropdownMenu>
              {turn.sources.length > 0 && <Sources sources={turn.sources} />}
              {model && <span className="ml-2 truncate text-xs opacity-80">{model}</span>}
            </div>
          )}

          {followUps.length > 0 && turn.status === 'succeeded' && turn.assistantMessage && !ctx.busy && (
            <div className="flex animate-rise flex-wrap gap-1.5 pt-1">
              {followUps.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => ctx.onSend(f)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm text-muted-foreground transition-colors hover:border-input hover:bg-hover hover:text-foreground"
                >
                  <CornerDownRight className="size-3.5" /> {f}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {turn.compactions?.map((c) => <CompactionDivider key={c.id} compaction={c} />)}
    </section>
  )
}

/** Keeps (the start of) an answer as a memory the user can edit on the Memory page. */
function remember(client: Client, text: string, treeId: string) {
  const short = text.trim().replace(/\s+/g, ' ').slice(0, MEMORY_LIMITS.text)
  client.addMemory({ text: short, source: 'saved', treeId }).then(
    (m) => toast.success('已存入记忆', { description: '可以在「记忆」里修改或删除。', action: { label: '撤销', onClick: () => client.removeMemory(m.id) } }),
    report,
  )
}

const memoryVerbs = { add: '已记住', update: '已更新记忆', remove: '已忘掉' } as const

/** What the model did with the `memory` tool, with an undo that reverses it. */
function MemoryChip({ details }: { details: MemoryToolDetails }) {
  const client = useClient()
  const [state, setState] = useState<'done' | 'undoing' | 'undone'>('done')
  const undo = () => {
    setState('undoing')
    const { action, memory, previous } = details
    const reverse =
      action === 'add'
        ? client.request({ t: 'memory.remove', memoryId: memory.id })
        : action === 'update' && previous
          ? client.request({ t: 'memory.update', memoryId: memory.id, text: previous.text, enabled: previous.enabled, projectId: previous.projectId })
          : client.addMemory({ text: (previous ?? memory).text, source: (previous ?? memory).source, treeId: memory.treeId ?? undefined, projectId: (previous ?? memory).projectId })
    reverse.then(
      () => setState('undone'),
      (e: unknown) => {
        setState('done')
        report(e)
      },
    )
  }
  const shown = details.action === 'remove' ? (details.previous ?? details.memory) : details.memory
  return (
    <div className="flex max-w-full items-center gap-2 self-start rounded-xl border bg-card py-1.5 pr-1.5 pl-3 text-sm">
      <Brain className="size-4 shrink-0 text-accent" />
      <span className={cn('min-w-0 truncate', state === 'undone' && 'text-muted-foreground line-through')}>
        <span className="text-muted-foreground">{state === 'undone' ? '已撤销' : memoryVerbs[details.action]}：</span>
        {shown.text}
      </span>
      {state !== 'undone' && (
        <Button variant="ghost" size="sm" disabled={state === 'undoing'} onClick={undo} className="shrink-0">
          {state === 'undoing' ? <Spinner /> : <Undo2 />} 撤销
        </Button>
      )}
      <Link to={{ name: 'memory' }} className="shrink-0 px-1.5 text-xs text-muted-foreground hover:text-foreground">
        管理
      </Link>
    </div>
  )
}

const reasonLabels: Record<FeedbackReason, string> = {
  inaccurate: '内容不准确',
  ignored: '没按要求做',
  'too-long': '太长了',
  'too-short': '太简略',
  unsafe: '不安全或不恰当',
  other: '其他',
}

/** 👍 / 👎 on an answer, kept on the server (roadmap-7 D1); 👎 asks what went wrong, optionally. */
function Feedback({ treeId, turnId }: { treeId: string; turnId: string }) {
  const client = useClient()
  const value = useHost().feedback[treeId]?.[turnId]?.value
  const [asking, setAsking] = useState(false)
  const set = (next: 'up' | 'down' | null) => {
    client.setFeedback(treeId, turnId, next).catch(report)
    if (next === 'up') toast('谢谢，已记下这个回答有帮助', { duration: 1800 })
    if (next === 'down') setAsking(true)
  }
  return (
    <>
      {value !== 'down' && (
        <Tooltip label="有帮助">
          <Button variant="ghost" size="icon-sm" aria-label="有帮助" aria-pressed={value === 'up'} onClick={() => set(value === 'up' ? null : 'up')} className={cn(value === 'up' && 'text-accent')}>
            <ThumbsUp className={cn(value === 'up' && 'fill-current')} />
          </Button>
        </Tooltip>
      )}
      {value !== 'up' && (
        <Popover open={asking} onOpenChange={setAsking}>
          <Tooltip label="没帮助">
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="没帮助"
                aria-pressed={value === 'down'}
                onClick={(e) => {
                  e.preventDefault()
                  set(value === 'down' ? null : 'down')
                }}
                className={cn(value === 'down' && 'text-foreground')}
              >
                <ThumbsDown className={cn(value === 'down' && 'fill-current')} />
              </Button>
            </PopoverTrigger>
          </Tooltip>
          <PopoverContent align="start" className="w-80">
            <WhyDown onDone={(more) => {
              setAsking(false)
              if (!more) return
              client.setFeedback(treeId, turnId, 'down', more).then(() => toast('谢谢，已记下', { duration: 1800 }), report)
            }} />
          </PopoverContent>
        </Popover>
      )}
    </>
  )
}

function WhyDown({ onDone }: { onDone: (more: { reasons: FeedbackReason[]; comment?: string } | null) => void }) {
  const [reasons, setReasons] = useState<FeedbackReason[]>([])
  const [comment, setComment] = useState('')
  const toggle = (r: FeedbackReason) => setReasons((rs) => (rs.includes(r) ? rs.filter((x) => x !== r) : [...rs, r]))
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        onDone({ reasons, ...(comment.trim() && { comment: comment.trim().slice(0, 500) }) })
      }}
    >
      <div className="text-sm font-medium">哪里不好？</div>
      <div className="flex flex-wrap gap-1.5">
        {FEEDBACK_REASONS.map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={reasons.includes(r)}
            onClick={() => toggle(r)}
            className={cn('h-7 rounded-full border px-2.5 text-xs transition-colors hover:bg-hover', reasons.includes(r) && 'border-accent bg-accent/10 text-foreground')}
          >
            {reasonLabels[r]}
          </button>
        ))}
      </div>
      <Textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} rows={2} placeholder="补充一句（可选）" className="min-h-0 text-sm" />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => onDone(null)}>
          跳过
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={!reasons.length && !comment.trim()}>
          提交
        </Button>
      </div>
    </form>
  )
}

function ReadAloud({ id, text }: { id: string; text: string }) {
  const speech = useSpeech(id)
  return (
    <Tooltip label={speech.speaking ? '停止朗读' : '朗读'}>
      <Button variant="ghost" size="icon-sm" aria-label="朗读" aria-pressed={speech.speaking} onClick={() => speech.toggle(text)} className={cn(speech.speaking && 'text-accent')}>
        {speech.speaking ? <Square className="size-3.5! fill-current" /> : <Volume2 />}
      </Button>
    </Tooltip>
  )
}

function Working({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center gap-2 text-sm">
      <span className="size-2 animate-pulse rounded-full bg-accent" />
      <span className="shimmer-text">{label}…</span>
    </div>
  )
}

// ── Steps: thinking and tool calls ─────────────────────────────────────────────────────────────────────────────────────

/** The one argument that says what a call is about, when it has one. */
function gist(input: unknown) {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  for (const key of ['query', 'q', 'url', 'command', 'path', 'file_path', 'title', 'prompt', 'name']) {
    const v = o[key]
    if (typeof v === 'string' && v.trim()) return v.trim().replace(/\s+/g, ' ')
  }
  return ''
}

const stepTitle = (step: Step, tools: ToolIndex) =>
  step.kind === 'thinking' ? '思考' : step.kind === 'native' ? nativeLabel[step.step.action].title : (tools.get(step.call.name)?.title ?? step.call.name)

// ── DeepSeek's own searches and page reads (roadmap-7 C2) ──

const nativeLabel: Record<NativeStep['action'], { title: string; doing: string; icon: typeof Globe }> = {
  search: { title: '联网搜索', doing: '正在搜索', icon: Search },
  image_search: { title: '搜索图片', doing: '正在搜索图片', icon: ImageIcon },
  open_page: { title: '阅读网页', doing: '正在阅读', icon: BookOpen },
  read_link: { title: '读取链接', doing: '正在读取链接', icon: BookOpen },
  find_in_page: { title: '在网页中查找', doing: '正在网页中查找', icon: Search },
}
const nativeErrors: Record<string, string> = { unavailable: '搜索暂时不可用', url_not_accessible: '网页打不开', timeout: '超时' }

const hostOfUrl = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
/** What a native step is about: its queries, the page, or the text it looked for. */
const nativeGist = (s: NativeStep) => (s.queries?.length ? s.queries.join(' · ') : s.pattern ? `“${s.pattern}”` : s.url ? hostOfUrl(s.url) : '')

const isRead = (s: NativeStep) => s.action === 'open_page' || s.action === 'read_link'

function Steps({ steps, tools, live }: { steps: Step[]; tools: ToolIndex; live: boolean }) {
  const [open, setOpen] = useState(false)
  const calls = steps.flatMap((s) => (s.kind === 'tool' ? [s.call] : []))
  const native = steps.flatMap((s) => (s.kind === 'native' ? [s.step] : []))
  const failed = calls.filter((c) => c.status === 'failed').length + native.filter((n) => n.status === 'failed').length
  const searches = native.filter((n) => !isRead(n) && n.action !== 'find_in_page').length
  const reads = native.filter(isRead).length
  const last = steps.at(-1)!
  const summary = [
    steps.some((s) => s.kind === 'thinking') && '思考',
    searches > 0 && `搜索 ${searches} 次`,
    reads > 0 && `阅读 ${reads} 个网页`,
    calls.length > 0 && `${calls.length} 次工具调用`,
  ]
    .filter(Boolean)
    .join(' · ')
  const current =
    last.kind === 'thinking'
      ? '正在思考'
      : last.kind === 'native'
        ? last.step.status === 'running'
          ? nativeLabel[last.step.action].doing
          : '正在继续'
        : last.call.status === 'running'
          ? `正在使用 ${stepTitle(last, tools)}`
          : '正在继续'
  const detail = !live ? '' : last.kind === 'tool' ? gist(last.call.input) : last.kind === 'native' ? nativeGist(last.step) : ''

  return (
    <div className="min-w-0 text-sm">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="group flex max-w-full items-center gap-1.5 rounded-full border py-1 pr-2 pl-2.5 text-left text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
      >
        {live ? <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" /> : <Check className="size-3.5 shrink-0" />}
        {live ? <span className="shimmer-text shrink-0">{current}</span> : <span className="shrink-0">{summary}</span>}
        {detail && <span className="min-w-0 truncate opacity-70">{detail}</span>}
        {!live && failed > 0 && <span className="shrink-0 text-warning">· {failed} 次失败</span>}
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <ol className="mt-2 ml-3 flex animate-rise flex-col gap-0.5 border-l pl-4">
          {steps.map((s, i) => (
            <li key={s.kind === 'tool' ? s.call.id : s.kind === 'native' ? `n${s.step.id}` : `t${i}`}>
              {s.kind === 'thinking' ? <ThinkingStep text={s.text} /> : s.kind === 'native' ? <NativeStepRow step={s.step} /> : <ToolStep call={s.call} meta={tools.get(s.call.name)} />}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function ThinkingStep({ text }: { text: string }) {
  return (
    <div className="flex gap-2 py-1 text-muted-foreground">
      <Brain className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 text-[13px] leading-relaxed break-words whitespace-pre-wrap">{text.trim()}</div>
    </div>
  )
}

function ToolStep({ call, meta }: { call: ToolCall; meta: ToolMeta | undefined }) {
  const [open, setOpen] = useState(false)
  const about = gist(call.input)
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="-ml-1.5 flex w-full min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-hover">
        {call.status === 'running' ? (
          <Spinner className="shrink-0" />
        ) : call.status === 'failed' ? (
          <X className="size-4 shrink-0 text-destructive" />
        ) : meta?.pluginKind === 'mcp' ? (
          <Puzzle className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <Wrench className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="shrink-0 font-medium">{meta?.title ?? call.name}</span>
        {about && <span className="min-w-0 flex-1 truncate text-muted-foreground">{about}</span>}
        {!about && <span className="flex-1" />}
        {call.durationMs != null && call.status !== 'running' && <span className="shrink-0 text-xs text-muted-foreground">{formatDuration(call.durationMs)}</span>}
      </button>
      {open && (
        <div className="mt-1 mb-2 flex flex-col gap-2 rounded-xl bg-muted/60 p-3 text-[13px]">
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <code className="font-mono">{call.name}</code>
            {meta && <Badge variant="outline">{meta.pluginName}</Badge>}
          </div>
          <Output label="参数" text={JSON.stringify(call.input, null, 2) ?? ''} />
          {call.result && <Output label={call.result.isError ? '错误' : '结果'} text={call.result.content} error={call.result.isError} />}
        </div>
      )}
    </div>
  )
}

function NativeStepRow({ step }: { step: NativeStep }) {
  const [open, setOpen] = useState(false)
  const label = nativeLabel[step.action]
  const results = step.results ?? []
  const about = nativeGist(step)
  const expandable = results.length > 0 || step.status === 'failed'
  return (
    <div>
      <button type="button" aria-expanded={open} disabled={!expandable} onClick={() => setOpen(!open)} className="-ml-1.5 flex w-full min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-left enabled:hover:bg-hover">
        {step.status === 'running' ? <Spinner className="shrink-0" /> : step.status === 'failed' ? <X className="size-4 shrink-0 text-destructive" /> : <label.icon className="size-4 shrink-0 text-muted-foreground" />}
        <span className="shrink-0 font-medium">{label.title}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{about}</span>
        {step.status === 'done' && !isRead(step) && results.length > 0 && <span className="shrink-0 text-xs text-muted-foreground">{results.length} 个结果</span>}
      </button>
      {open && (
        <div className="mt-1 mb-2 rounded-xl bg-muted/60 p-1.5 text-[13px]">
          {step.status === 'failed' && <p className="px-1.5 py-1 text-destructive">{nativeErrors[step.error ?? ''] ?? step.error ?? '没有完成'}</p>}
          <ol>
            {results.map((r) => (
              <li key={r.url}>
                <SourceLink source={r} />
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}

function SourceLink({ source: r }: { source: NativeSource }) {
  const site = r.site || hostOfUrl(r.url)
  return (
    <a href={r.url} target="_blank" rel="noreferrer noopener" className="flex flex-col gap-0.5 rounded-lg px-1.5 py-1.5 hover:bg-hover">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <SiteBadge site={site} className="size-4 ring-0" /> <span className="truncate">{site}</span>
        {r.publishedAt && <span className="shrink-0">· {r.publishedAt.slice(0, 10)}</span>}
      </span>
      <span className="line-clamp-1">{r.title || r.url}</span>
      {r.snippet && <span className="line-clamp-2 text-xs text-muted-foreground">{r.snippet}</span>}
    </a>
  )
}

function Output({ label, text: raw, error }: { label: string; text: string; error?: boolean }) {
  const [open, setOpen] = useState(false)
  // The runtime wraps its own notes (exit code, truncation) in <harness> tags meant for the model.
  const text = raw.replace(/<harness>\s*([\s\S]*?)\s*<\/harness>/g, '$1').trim()
  const long = text.length > 400 || text.split('\n').length > 8
  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <pre className={cn('overflow-x-auto rounded-lg bg-card p-2.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap', error && 'text-destructive', long && !open && 'max-h-40 overflow-y-hidden')}>
        {text || '（空）'}
      </pre>
      {long && (
        <button type="button" className="mt-1 text-xs text-accent hover:underline" onClick={() => setOpen(!open)}>
          {open ? '收起' : '展开全部'}
        </button>
      )}
    </div>
  )
}

// ── The user's side ────────────────────────────────────────────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, flash] = useFlash()
  return (
    <Tooltip label={copied ? '已复制' : '复制'}>
      <Button variant="ghost" size="icon-sm" aria-label="复制" onClick={() => void copyText(text).then((ok) => ok && flash())}>
        {copied ? <Check /> : <Copy />}
      </Button>
    </Tooltip>
  )
}

/** "‹ 2 / 3 ›" between sibling versions of a message. */
function VersionNav({ versions, onShow, disabled }: { versions: Versions; onShow: (id: string) => void; disabled: boolean }) {
  const { ids, index } = versions
  return (
    <span className="inline-flex items-center text-xs tabular-nums">
      <Button variant="ghost" size="icon-xs" aria-label="上一个版本" disabled={disabled || index === 0} onClick={() => onShow(ids[index - 1]!)}>
        <ChevronLeft />
      </Button>
      {index + 1} / {ids.length}
      <Button variant="ghost" size="icon-xs" aria-label="下一个版本" disabled={disabled || index === ids.length - 1} onClick={() => onShow(ids[index + 1]!)}>
        <ChevronRight />
      </Button>
    </span>
  )
}

const mentionIcon = { plugin: Puzzle, workspace: FolderOpen, chat: MessageSquare }
const chip = 'inline-flex h-7 max-w-64 items-center gap-1.5 rounded-full border bg-card px-2.5 text-sm [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground'

function UserMessage({
  turn,
  versions,
  busy,
  onShow,
  onEdit,
}: {
  turn: Turn
  versions?: Versions
  busy: boolean
  onShow: (id: string) => void
  /** Present when the message may be edited now. */
  onEdit?: (text: string) => void
}) {
  const text = turn.userMessage
  const ref = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  useLayoutEffect(() => {
    if (ref.current) setOverflow(ref.current.scrollHeight > 300)
  }, [text])

  const refs = (turn.attachments?.length || turn.command || turn.mentions?.length) && (
    <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
      {turn.command && (
        <span className={cn(chip, 'border-transparent bg-accent-soft text-accent [&_svg]:text-accent')}>
          <Slash /> <span className="truncate">{turn.command.label}</span>
        </span>
      )}
      {turn.mentions?.map((m) => {
        const Icon = mentionIcon[m.kind]
        return (
          <span key={m.kind + m.id} className={chip}>
            <Icon /> <span className="truncate">{m.label}</span>
          </span>
        )
      })}
      {turn.attachments?.map((f) => (
        <span key={f.id} className={chip} title={f.id}>
          {f.parsed?.how === 'ocr' ? <ScanText /> : <FileText />} <span className="truncate">{f.name}</span>
          {f.size != null && <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(f.size)}</span>}
          {f.parsed && (
            <span className="shrink-0 text-xs text-muted-foreground" title="服务器把它转成了文字，模型读的是文字版">
              · {f.parsed.how === 'ocr' ? `已识别${f.parsed.pages ? ` ${f.parsed.pages} 页` : ''}` : '已解析'}
            </span>
          )}
        </span>
      ))}
    </div>
  )

  if (draft != null)
    return (
      <div className="flex flex-col gap-2 rounded-2xl border border-input bg-card p-3">
        <Textarea
          value={draft}
          autoFocus
          aria-label="编辑消息"
          rows={Math.min(10, draft.split('\n').length + 1)}
          className="border-0 bg-transparent p-1 text-[15px] focus-visible:ring-0"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setDraft(null)}
        />
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto pl-1 text-xs text-muted-foreground">修改后会另起一个版本，原来的回答还在。</span>
          <Button size="sm" onClick={() => setDraft(null)}>
            取消
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!draft.trim() || draft.trim() === text.trim() || !onEdit}
            onClick={() => {
              onEdit?.(draft.trim())
              setDraft(null)
            }}
          >
            发送
          </Button>
        </div>
      </div>
    )

  return (
    <div className="group/user flex flex-col items-end gap-1.5">
      {refs}
      {text && (
        <div className="max-w-[85%] rounded-3xl rounded-br-md bg-bubble px-4.5 py-2.5 leading-relaxed">
          <div ref={ref} className={cn('break-words whitespace-pre-wrap', overflow && !expanded && 'max-h-75 overflow-hidden mask-b-from-70%')}>
            {text}
          </div>
          {overflow && (
            <button type="button" className="mt-1 text-sm text-accent hover:underline" onClick={() => setExpanded(!expanded)}>
              {expanded ? '收起' : '展开'}
            </button>
          )}
        </div>
      )}
      <div
        className={cn(
          'flex h-8 items-center gap-0.5 text-muted-foreground transition-opacity group-hover/user:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100',
          !versions && 'opacity-0',
        )}
      >
        {versions && <VersionNav versions={versions} onShow={onShow} disabled={busy} />}
        {text && <CopyButton text={text} />}
        {onEdit && (
          <Tooltip label="编辑">
            <Button variant="ghost" size="icon-sm" aria-label="编辑" onClick={() => setDraft(text)}>
              <PencilLine />
            </Button>
          </Tooltip>
        )}
      </div>
    </div>
  )
}

// ── Events and sources ─────────────────────────────────────────────────────────────────────────────────────────────────

const eventSource: Record<EventData['source']['kind'], { label: string; icon: typeof Clock; named: boolean }> = {
  branch: { label: '分叉', icon: GitBranch, named: true },
  agent: { label: '子代理', icon: Bot, named: true },
  schedule: { label: '定时任务', icon: Clock, named: true },
  webhook: { label: 'Webhook', icon: Webhook, named: false },
  system: { label: '系统', icon: Info, named: false },
  channel: { label: '渠道', icon: Radio, named: true },
}

/** An Event in the transcript (R46): where it came from and its title, opening to its body. */
function EventCard({ event, queued }: { event: EventData; queued: boolean }) {
  const [open, setOpen] = useState(false)
  const source = eventSource[event.source.kind] ?? eventSource.system
  const Icon = source.icon
  return (
    <div className="overflow-hidden rounded-2xl border bg-card text-sm">
      <button type="button" aria-expanded={open} disabled={!event.body} onClick={() => setOpen(!open)} className="flex w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left enabled:hover:bg-hover">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-muted-foreground">{source.named && event.source.label ? `${source.label}「${event.source.label}」` : source.label}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{event.title}</span>
        {queued ? <Badge>排队中</Badge> : !event.wake && <Badge>未打断对话</Badge>}
        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{formatTime(event.createdAt)}</span>
        {event.body && <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />}
      </button>
      {open && event.body && (
        <div className="border-t px-3.5 py-3">
          <Markdown text={event.body} className="text-sm" />
        </div>
      )}
    </div>
  )
}

/** First letter of the site on a colour derived from its name; no favicon requests leave the page. */
function SiteBadge({ site, className }: { site: string; className?: string }) {
  let h = 0
  for (const ch of site) h = (h * 31 + ch.charCodeAt(0)) % 360
  return (
    <span aria-hidden className={cn('grid size-4.5 shrink-0 place-items-center rounded-full text-[10px] font-semibold text-white ring-2 ring-background', className)} style={{ background: `hsl(${h} 45% 42%)` }}>
      {site.charAt(0).toUpperCase()}
    </span>
  )
}

/** Web pages the turn used: stacked site badges that open the list. */
function Sources({ sources }: { sources: WebSource[] }): ReactNode {
  return (
    <Popover>
      <PopoverTrigger className="ml-1 inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-sm outline-none hover:bg-hover hover:text-foreground data-[state=open]:bg-hover">
        <span className="flex -space-x-1.5">
          {sources.slice(0, 3).map((s) => (
            <SiteBadge key={s.url} site={s.site} />
          ))}
        </span>
        {sources.length} 个来源
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(92vw,380px)] p-1">
        <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-1 text-xs text-muted-foreground">
          <Globe className="size-3.5" /> 回答用到的网页
        </div>
        <ol>
          {sources.map((s) => (
            <li key={s.url}>
              <a href={s.url} target="_blank" rel="noreferrer noopener" className="flex flex-col gap-0.5 rounded-lg px-2.5 py-2 hover:bg-hover">
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <SiteBadge site={s.site} className="size-4 ring-0" /> <span className="truncate">{s.site}</span>
                </span>
                <span className="line-clamp-2 text-sm">{s.title}</span>
              </a>
            </li>
          ))}
        </ol>
      </PopoverContent>
    </Popover>
  )
}
