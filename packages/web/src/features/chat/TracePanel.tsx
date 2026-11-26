// Developer mode: the model requests and tool runs behind a conversation, beside it like the file panel. Each turn is a
// waterfall of its steps; a step opens to its output, the context the model saw, its usage and the raw entry.
import { AlertTriangle, Brain, Check, ChevronRight, Copy, Cpu, Download, Info, Settings2, Wrench } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useHost } from '../../app/client'
import { cn } from '../../lib/cn'
import { copyText, formatDuration, saveBlob } from '../../lib/format'
import { useFlash } from '../../lib/hooks'
import { addTotals, emptyTotals, spanOf, systemPromptText, toTrace, type CallContext, type ModelStep, type ToolStep, type TraceStep, type TraceTotals, type TraceTurn } from '../../lib/trace'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Spinner } from '../../ui/feedback'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs'
import { Tooltip } from '../../ui/tooltip'

/** 1234 → "1.2k", 1234567 → "1.23M". */
export function formatTokens(n: number) {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

const formatCost = (usd: number) => (usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`)

/** Share of prompt tokens served from the provider's cache. */
const cacheRate = (t: { input: number; cacheRead: number; cacheWrite: number }) => {
  const prompt = t.input + t.cacheRead + t.cacheWrite
  return prompt ? Math.round((t.cacheRead / prompt) * 100) : 0
}

export function TracePanel({ treeId, focus }: { treeId: string; focus?: string }) {
  const view = useHost().views[treeId]
  const trace = useMemo(() => (view ? toTrace(view) : undefined), [view])
  const list = useRef<HTMLDivElement>(null)

  // A turn asked for from the transcript scrolls into view, opened.
  useEffect(() => {
    if (!focus) return
    list.current?.querySelector(`[data-trace-turn="${CSS.escape(focus)}"]`)?.scrollIntoView({ block: 'start' })
  }, [focus, !!trace])

  if (!view || !trace) return <p className="p-4 text-sm text-muted-foreground">正在加载…</p>
  if (!trace.turns.length) return <p className="p-4 text-sm text-muted-foreground">还没有模型调用。</p>

  const download = () => saveBlob(`trace-${treeId}.json`, new Blob([JSON.stringify(view, null, 2)], { type: 'application/json' }))

  return (
    <div ref={list} className="flex flex-col">
      <div className="sticky top-0 z-10 border-b bg-background/95 px-4 py-3 backdrop-blur">
        <Totals totals={trace.totals} />
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="flex-1">当前分支 · {view.entries.length} 条记录</span>
          <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={download}>
            <Download className="size-3.5" /> 下载原始记录
          </Button>
        </div>
      </div>
      <ol className="flex flex-col">
        {trace.turns.map((t, i) => (
          <TurnTrace key={t.id} turn={t} index={i + 1} initiallyOpen={t.id === focus || (!focus && i === trace.turns.length - 1)} />
        ))}
      </ol>
    </div>
  )
}

function Totals({ totals: t }: { totals: TraceTotals }) {
  const items: { label: string; value: string; hint?: string }[] = [
    { label: '模型调用', value: String(t.calls), hint: formatDuration(t.modelMs) },
    { label: '工具调用', value: String(t.tools), hint: t.failedTools ? `${t.failedTools} 次失败` : formatDuration(t.toolMs) },
    { label: '输入', value: formatTokens(t.input + t.cacheRead + t.cacheWrite), hint: `缓存命中 ${cacheRate(t)}%` },
    { label: '输出', value: formatTokens(t.output), hint: t.reasoning ? `推理 ${formatTokens(t.reasoning)}` : undefined },
  ]
  if (t.cost > 0) items.push({ label: '费用', value: formatCost(t.cost) })
  return (
    <dl className="grid grid-cols-[repeat(auto-fit,minmax(5.5rem,1fr))] gap-2">
      {items.map((it) => (
        <div key={it.label} className="min-w-0 rounded-lg bg-muted/60 px-2.5 py-1.5">
          <dt className="text-[11px] text-muted-foreground">{it.label}</dt>
          <dd className="truncate font-mono text-sm font-medium tabular-nums">{it.value}</dd>
          {it.hint && <dd className={cn('truncate text-[11px] text-muted-foreground', it.hint.includes('失败') && 'text-warning')}>{it.hint}</dd>}
        </div>
      ))}
    </dl>
  )
}

function TurnTrace({ turn, index, initiallyOpen }: { turn: TraceTurn; index: number; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)
  useEffect(() => {
    if (initiallyOpen) setOpen(true)
  }, [initiallyOpen])
  const totals = useMemo(() => turn.steps.reduce(addTotals, emptyTotals()), [turn.steps])
  const live = turn.steps.some((s) => s.kind === 'model' && s.live)
  // The turn's time span, which the waterfall's bars are placed in.
  const spans = turn.steps.map((s) => spanOf(s))
  const known = spans.filter((s) => s !== undefined)
  const from = known.length ? Math.min(...known.map((s) => s.start)) : 0
  const to = known.length ? Math.max(...known.map((s) => s.end)) : 0

  return (
    <li data-trace-turn={turn.id} className="border-b last:border-b-0">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full min-w-0 items-center gap-2 px-4 py-2.5 text-left hover:bg-hover">
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className="shrink-0 font-mono text-xs text-muted-foreground">#{index}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{turn.label}</span>
        {live && <Spinner className="shrink-0" />}
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
          {totals.calls} 调用 · {formatTokens(totals.input + totals.cacheRead + totals.cacheWrite + totals.output)} tok{to > from && ` · ${formatDuration(to - from)}`}
        </span>
      </button>
      {open && (
        <ol className="flex flex-col pb-2">
          {turn.steps.length === 0 && <li className="px-4 py-1.5 pl-10 text-xs text-muted-foreground">没有模型调用（排队中，或被拦下）。</li>}
          {turn.steps.map((s, i) => (
            <StepRow key={s.id + s.kind} step={s} span={spans[i]} from={from} to={to} />
          ))}
        </ol>
      )}
    </li>
  )
}

function StepRow({ step, span, from, to }: { step: TraceStep; span?: { start: number; end: number }; from: number; to: number }) {
  const [open, setOpen] = useState(false)
  const width = to - from
  const bar = span && width > 0 ? { left: ((span.start - from) / width) * 100, width: Math.max(((span.end - span.start) / width) * 100, 0.8) } : undefined
  const failed = (step.kind === 'tool' && step.isError) || (step.kind === 'model' && (step.stopReason === 'error' || step.stopReason === 'aborted')) || (step.kind === 'note' && step.tone === 'error')

  const icon =
    step.kind === 'model' ? (
      step.live ? <Spinner className="size-3.5" /> : <Cpu className="size-3.5 text-[var(--series-1)]" />
    ) : step.kind === 'tool' ? (
      <Wrench className={cn('size-3.5', failed ? 'text-destructive' : 'text-[var(--series-3)]')} />
    ) : step.kind === 'system' ? (
      <Settings2 className="size-3.5 text-muted-foreground" />
    ) : failed ? (
      <AlertTriangle className="size-3.5 text-destructive" />
    ) : (
      <Info className="size-3.5 text-muted-foreground" />
    )

  const label =
    step.kind === 'model' ? (
      <>
        <span className="font-medium">模型 #{step.n}</span> <span className="text-muted-foreground">{step.model}</span>
      </>
    ) : step.kind === 'tool' ? (
      <span className="font-mono font-medium">{step.name}</span>
    ) : step.kind === 'system' ? (
      <span className="text-muted-foreground">{systemLabel(step)}</span>
    ) : (
      <span className={cn(failed ? 'text-destructive' : 'text-muted-foreground')}>{step.text}</span>
    )

  const metric =
    step.kind === 'model'
      ? [step.usage && `${formatTokens(step.usage.input + step.usage.cacheRead + step.usage.cacheWrite)}→${formatTokens(step.usage.output)}`, step.durationMs !== undefined && formatDuration(step.durationMs)].filter(Boolean).join(' · ')
      : step.kind === 'tool' && step.durationMs !== undefined
        ? formatDuration(step.durationMs)
        : ''

  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn('grid w-full grid-cols-[minmax(0,13rem)_minmax(3rem,1fr)_7.5rem] items-center gap-3 py-1 pr-4 pl-10 text-left text-xs hover:bg-hover', open && 'bg-hover')}
      >
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          <span className="shrink-0">{icon}</span>
          <span className="truncate">{label}</span>
        </span>
        <span className="relative h-2.5 rounded-sm bg-muted/50">
          {bar && (
            <span
              className={cn('absolute inset-y-0 rounded-sm', step.kind === 'model' ? 'bg-[var(--series-1)]' : 'bg-[var(--series-3)]', failed && 'bg-destructive', step.kind === 'model' && step.live && 'animate-pulse')}
              style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
            />
          )}
        </span>
        <span className="truncate text-right font-mono text-[11px] text-muted-foreground tabular-nums">{metric}</span>
      </button>
      {open && (
        <div className="mx-4 mt-1 mb-2 ml-10 animate-rise rounded-xl border bg-card p-3 text-xs">
          {step.kind === 'model' ? <ModelDetail step={step} /> : step.kind === 'tool' ? <ToolDetail step={step} /> : <Raw value={step.raw} />}
        </div>
      )}
    </li>
  )
}

function systemLabel(s: Extract<TraceStep, { kind: 'system' }>) {
  if (s.baseline) return `系统提示 · ${s.set.length} 段 · ${s.toolsAdded.length} 个工具`
  const parts = [s.set.length && `更新 ${s.set.join('、')}`, s.removed.length && `移除 ${s.removed.join('、')}`, s.toolsAdded.length && `+${s.toolsAdded.length} 工具`, s.toolsRemoved.length && `−${s.toolsRemoved.length} 工具`].filter(Boolean)
  return `系统提示 · ${parts.join(' · ') || '无变化'}`
}

// ── Details ────────────────────────────────────────────────────────────────────────────────────────────────────────────

function ModelDetail({ step }: { step: ModelStep }) {
  return (
    <Tabs defaultValue="output">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <TabsList className="p-0.5">
          {(['output', 'context', 'usage', 'raw'] as const).map((v) => (
            <TabsTrigger key={v} value={v} className="h-6 px-2 text-xs">
              {{ output: '输出', context: '上下文', usage: '用量', raw: '原始' }[v]}
            </TabsTrigger>
          ))}
        </TabsList>
        <span className="flex-1" />
        {step.stopReason && <Badge variant={step.stopReason === 'error' ? 'destructive' : step.stopReason === 'aborted' ? 'warning' : 'outline'}>{step.stopReason}</Badge>}
        {step.live && <Badge variant="accent">生成中</Badge>}
      </div>
      <TabsContent value="output" className="flex flex-col gap-2">
        {step.error && <Block label="错误" text={step.error} tone="error" />}
        {step.output.length === 0 && !step.error && <p className="text-muted-foreground">（没有输出）</p>}
        {step.output.map((p, i) =>
          p.type === 'thinking' ? (
            <Block key={i} label={<><Brain className="size-3" /> 思考</>} text={p.thinking ?? ''} muted />
          ) : p.type === 'toolCall' ? (
            <Block key={i} label={<><Wrench className="size-3" /> 调用 <code className="font-mono">{p.name}</code> <span className="opacity-60">{p.id}</span></>} text={JSON.stringify(p.arguments ?? {}, null, 2)} />
          ) : (
            <Block key={i} label="文本" text={p.text ?? ''} />
          ),
        )}
      </TabsContent>
      <TabsContent value="context">
        <ContextDetail ctx={step.context} />
      </TabsContent>
      <TabsContent value="usage">
        <UsageDetail step={step} />
      </TabsContent>
      <TabsContent value="raw">
        <Raw value={step.raw} />
      </TabsContent>
    </Tabs>
  )
}

function ContextDetail({ ctx }: { ctx: CallContext }) {
  const prompt = systemPromptText(ctx)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="flex-1">
          系统提示 {ctx.sections.length} 段 · {prompt.length.toLocaleString()} 字符 · 此前 {ctx.messages} 条消息
        </span>
        <CopyText text={prompt} label="复制系统提示" />
      </div>
      <ul className="flex flex-col gap-1">
        {ctx.sections.map(([key, text]) => (
          <Collapsible key={key} title={<code className="font-mono">{key}</code>} meta={`${text.length.toLocaleString()} 字符`}>
            <Pre text={text} />
          </Collapsible>
        ))}
      </ul>
      <div className="text-muted-foreground">工具 {ctx.tools.length} 个</div>
      <ul className="flex flex-col gap-1">
        {ctx.tools.map((t) => (
          <Collapsible key={t.name} title={<code className="font-mono">{t.name}</code>} meta={t.description?.split('\n')[0]} metaStart>
            {t.description && <Pre text={t.description} />}
            <Pre text={JSON.stringify(t.parameters ?? {}, null, 2)} />
          </Collapsible>
        ))}
      </ul>
    </div>
  )
}

function UsageDetail({ step }: { step: ModelStep }) {
  const u = step.usage
  const rows: [string, ReactNode][] = [
    ['模型', `${step.provider}:${step.model}`],
    ['接口', step.api],
    ['推理强度', step.thinkingLevel],
    ['开始', step.start ? new Date(step.start).toLocaleString() : undefined],
    ['耗时', step.durationMs !== undefined ? formatDuration(step.durationMs) : undefined],
    ['输入（未缓存）', u && u.input.toLocaleString()],
    ['缓存读', u && u.cacheRead.toLocaleString()],
    ['缓存写', u && u.cacheWrite.toLocaleString()],
    ['缓存命中', u && `${cacheRate(u)}%`],
    ['输出', u && u.output.toLocaleString()],
    ['其中推理', u?.reasoning !== undefined ? u.reasoning.toLocaleString() : undefined],
    ['合计', u && u.totalTokens.toLocaleString()],
    ['输出速度', u && step.durationMs ? `${((u.output / step.durationMs) * 1000).toFixed(1)} tok/s` : undefined],
    ['费用', u?.cost?.total ? formatCost(u.cost.total) : undefined],
    ['停止原因', step.stopReason],
    ['响应 ID', step.responseId],
  ]
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      {rows
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0 font-mono break-all tabular-nums">{v}</dd>
          </div>
        ))}
    </dl>
  )
}

function ToolDetail({ step }: { step: ToolStep }) {
  return (
    <Tabs defaultValue="io">
      <div className="mb-2 flex items-center gap-1.5">
        <TabsList className="p-0.5">
          <TabsTrigger value="io" className="h-6 px-2 text-xs">
            参数与结果
          </TabsTrigger>
          <TabsTrigger value="raw" className="h-6 px-2 text-xs">
            原始
          </TabsTrigger>
        </TabsList>
        <span className="flex-1" />
        <code className="truncate font-mono text-[11px] text-muted-foreground">{step.callId}</code>
        {step.isError && <Badge variant="destructive">error</Badge>}
      </div>
      <TabsContent value="io" className="flex flex-col gap-2">
        <Block label="参数" text={JSON.stringify(step.input, null, 2) ?? ''} />
        <Block label={step.isError ? '错误' : '结果'} text={step.output} tone={step.isError ? 'error' : undefined} />
      </TabsContent>
      <TabsContent value="raw">
        <Raw value={step.raw} />
      </TabsContent>
    </Tabs>
  )
}

// ── Pieces ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

function Collapsible({ title, meta, metaStart, children }: { title: ReactNode; meta?: string; metaStart?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="rounded-lg border">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full min-w-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left hover:bg-hover">
        <ChevronRight className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className="shrink-0">{title}</span>
        {meta && <span className={cn('min-w-0 flex-1 truncate text-muted-foreground', !metaStart && 'text-right')}>{meta}</span>}
      </button>
      {open && <div className="flex flex-col gap-2 border-t p-2">{children}</div>}
    </li>
  )
}

function Block({ label, text, tone, muted }: { label: ReactNode; text: string; tone?: 'error'; muted?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center gap-1 text-[11px] text-muted-foreground">
        <span className="flex flex-1 items-center gap-1">{label}</span>
        <CopyText text={text} label="复制" />
      </div>
      <Pre text={text} className={cn(tone === 'error' && 'text-destructive', muted && 'text-muted-foreground')} />
    </div>
  )
}

function Pre({ text, className }: { text: string; className?: string }) {
  const [all, setAll] = useState(false)
  const long = text.length > 2000 || text.split('\n').length > 30
  return (
    <div>
      <pre className={cn('overflow-x-auto rounded-lg bg-muted/60 p-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap', long && !all && 'max-h-72 overflow-y-hidden', className)}>{text || '（空）'}</pre>
      {long && (
        <button type="button" className="mt-1 text-[11px] text-accent hover:underline" onClick={() => setAll(!all)}>
          {all ? '收起' : `展开全部（${text.length.toLocaleString()} 字符）`}
        </button>
      )}
    </div>
  )
}

function Raw({ value }: { value: unknown }) {
  const text = useMemo(() => JSON.stringify(value, null, 2) ?? '', [value])
  return <Block label="JSON" text={text} />
}

function CopyText({ text, label }: { text: string; label: string }) {
  const [copied, flash] = useFlash()
  return (
    <Tooltip label={copied ? '已复制' : label}>
      <Button variant="ghost" size="icon-xs" aria-label={label} className="size-6" onClick={() => void copyText(text).then((ok) => ok && flash())}>
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </Button>
    </Tooltip>
  )
}
