// Context compaction in the transcript (roadmap-6 C3, C4): a divider where a summary replaced older context for the
// model, which opens to show the summary, and a line above the composer while one runs or after one failed.
import type { CompactionFailure, CompactionReason, CompactionStatus } from '@gense/protocol'
import { ChevronDown, Layers, RefreshCw, X } from 'lucide-react'
import { useId, useState } from 'react'
import { cn } from '../../lib/cn'
import type { Compaction } from '../../lib/types'
import { Button } from '../../ui/button'
import { Spinner } from '../../ui/feedback'
import { Markdown } from './Markdown'

const reasonText: Record<CompactionReason, string> = { manual: '手动压缩', threshold: '自动压缩', overflow: '超出上下文后压缩' }

export function CompactionDivider({ compaction }: { compaction: Compaction }) {
  const [open, setOpen] = useState(false)
  const panel = useId()
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1.5 rounded-full px-2 py-1 hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Layers className="size-3.5" />
          上文已压缩 · {reasonText[compaction.reason]}
          <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
        </button>
        <span className="h-px flex-1 bg-border" />
      </div>
      {open && (
        <div id={panel} className="rounded-xl bg-muted px-4 py-3 text-sm">
          <p className="mb-2 text-xs text-muted-foreground">模型此后看到的是这份摘要，而不是上面的原文；上面的消息仍保留在这里。</p>
          <Markdown text={compaction.summary || '（摘要为空）'} />
        </div>
      )}
    </div>
  )
}

/** Nothing while idle; a spinner while a compaction runs; the error, with retry, after one failed. */
export function CompactionLine({ running, failure, onRetry }: { running: CompactionStatus[]; failure?: CompactionFailure; onRetry: () => void }) {
  const [dismissed, setDismissed] = useState<number>()
  const task = running[0]
  if (task) {
    return (
      <p role="status" className="mb-2 flex items-center gap-2 px-1 text-sm text-muted-foreground">
        <Spinner />
        {task.blocking ? '正在压缩上下文，完成后继续回答…' : '正在压缩上下文…'}
        {task.retry && <span className="truncate">（重试中：{task.retry.error}）</span>}
      </p>
    )
  }
  if (!failure || dismissed === failure.taskId) return null
  return (
    <div role="alert" className="mb-2 flex items-center gap-2 rounded-xl bg-destructive-soft py-1.5 pr-1.5 pl-3 text-sm text-destructive">
      <span className="min-w-0 flex-1 truncate" title={failure.error}>
        上下文压缩失败：{failure.error}
      </span>
      <Button size="sm" variant="ghost" onClick={onRetry}>
        <RefreshCw /> 重试
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label="关闭" onClick={() => setDismissed(failure.taskId)}>
        <X />
      </Button>
    </div>
  )
}
