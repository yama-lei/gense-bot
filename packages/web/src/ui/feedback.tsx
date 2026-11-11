import { CircleAlert, Info, LoaderCircle, TriangleAlert } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../lib/cn'

export function Spinner({ className, ...props }: ComponentProps<'svg'>) {
  return <LoaderCircle role="status" aria-label="加载中" className={cn('size-4 animate-spin text-muted-foreground', className)} {...props} />
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-muted', className)} />
}

const tones = {
  info: { box: 'bg-muted text-foreground', icon: Info },
  warning: { box: 'bg-warning-soft text-warning', icon: TriangleAlert },
  error: { box: 'bg-destructive-soft text-destructive', icon: CircleAlert },
}

/** An inline notice: what happened, and an optional action on the right. */
export function Notice({ tone = 'info', title, children, action, className }: { tone?: keyof typeof tones; title?: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  const Icon = tones[tone].icon
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cn('flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-sm', tones[tone].box, className)}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        {title && <div className="font-medium">{title}</div>}
        {children && <div className={cn('break-words', title && 'opacity-90')}>{children}</div>}
      </div>
      {action}
    </div>
  )
}

/** What a list or page shows when it has nothing yet. */
export function Empty({ icon, title, children, action, className }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center gap-2 rounded-2xl border border-dashed px-6 py-10 text-center', className)}>
      {icon && <div className="mb-1 text-muted-foreground [&_svg]:size-7">{icon}</div>}
      <div className="font-medium">{title}</div>
      {children && <p className="max-w-sm text-sm text-muted-foreground">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
