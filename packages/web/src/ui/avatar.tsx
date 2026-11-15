import { cn } from '../lib/cn'

/** The account's mark: the first letter of its name on the accent. */
export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span aria-hidden className={cn('grid size-7 shrink-0 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-foreground uppercase', className)}>
      {[...name.trim()][0] ?? '·'}
    </span>
  )
}
