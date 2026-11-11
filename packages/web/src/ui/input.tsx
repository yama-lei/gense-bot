import type { ComponentProps } from 'react'
import { cn } from '../lib/cn'

const field =
  'w-full min-w-0 rounded-lg border border-input bg-card px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 disabled:opacity-50 aria-invalid:border-destructive'

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(field, 'h-9', className)} {...props} />
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(field, 'min-h-20 resize-y py-2 leading-relaxed', className)} {...props} />
}

/** A labelled form row: label, optional help, the control, optional error. */
export function Field({ label, help, error, children, className }: { label: string; help?: string; error?: string | null; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn('flex flex-col gap-1.5 text-sm', className)}>
      <span className="font-medium">{label}</span>
      {children}
      {help && !error && <span className="text-xs text-muted-foreground">{help}</span>}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </label>
  )
}
