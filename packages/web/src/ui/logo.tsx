import type { ComponentProps } from 'react'
import { cn } from '../lib/cn'

/** The mark: an open ring around a dot (also public/favicon.svg). */
export function Logo({ className, ...props }: ComponentProps<'svg'>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={cn('size-6 text-accent', className)} {...props}>
      <path d="M19.2 12a7.2 7.2 0 1 1-2.1-5.1" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="12" cy="12" r="2.4" fill="currentColor" />
    </svg>
  )
}
