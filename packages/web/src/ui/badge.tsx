import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '../lib/cn'

const badge = cva('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3', {
  variants: {
    variant: {
      neutral: 'bg-muted text-muted-foreground',
      outline: 'border text-muted-foreground',
      accent: 'bg-accent-soft text-accent',
      success: 'bg-success-soft text-success',
      warning: 'bg-warning-soft text-warning',
      destructive: 'bg-destructive-soft text-destructive',
    },
  },
  defaultVariants: { variant: 'neutral' },
})

export function Badge({ className, variant, ...props }: ComponentProps<'span'> & VariantProps<typeof badge>) {
  return <span className={cn(badge({ variant }), className)} {...props} />
}

/** Marks what the interface offers ahead of the server: it works in this browser, and is not synced yet. */
export function PreviewBadge({ className }: { className?: string }) {
  return (
    <span title="抢先预览：数据暂存在这个浏览器，服务端支持后会自动同步" className={cn('inline-flex shrink-0 items-center rounded-full border border-dashed border-accent/50 px-1.5 text-[10.5px] leading-4 font-medium text-accent', className)}>
      预览
    </span>
  )
}
