import { X } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../lib/cn'
import { Button } from './button'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

const overlay = 'fixed inset-0 z-50 bg-overlay data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0'

/** A centred dialog; on a phone it is a sheet from the bottom that never exceeds the screen. */
export function DialogContent({
  className,
  children,
  title,
  description,
  hideClose,
  ...props
}: Omit<ComponentProps<typeof DialogPrimitive.Content>, 'title'> & { title: ReactNode; description?: ReactNode; hideClose?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={overlay} />
      <DialogPrimitive.Content
        className={cn(
          'fixed z-50 flex max-h-[min(88dvh,760px)] w-full flex-col bg-popover shadow-pop outline-none',
          'inset-x-0 bottom-0 rounded-t-2xl pb-[env(safe-area-inset-bottom)] data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom-6 data-[state=open]:fade-in-0',
          'sm:inset-x-auto sm:bottom-auto sm:top-1/2 sm:left-1/2 sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:pb-0 sm:data-[state=open]:slide-in-from-bottom-2 sm:data-[state=open]:zoom-in-97',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          className,
        )}
        {...(!description && { 'aria-describedby': undefined })}
        {...props}
      >
        <header className="flex items-start gap-3 px-5 pt-4 pb-3">
          <div className="min-w-0 flex-1">
            <DialogPrimitive.Title className="text-base font-semibold">{title}</DialogPrimitive.Title>
            {description && <DialogPrimitive.Description className="mt-0.5 text-sm text-muted-foreground">{description}</DialogPrimitive.Description>}
          </div>
          {!hideClose && (
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="关闭" className="-mr-2 -mt-1">
                <X />
              </Button>
            </DialogPrimitive.Close>
          )}
        </header>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export const DialogBody = ({ className, ...props }: ComponentProps<'div'>) => <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 pb-5', className)} {...props} />
export const DialogFooter = ({ className, ...props }: ComponentProps<'div'>) => <div className={cn('flex flex-wrap justify-end gap-2 border-t px-5 py-3', className)} {...props} />

/** A drawer from the left edge, for the sidebar on a phone. */
export function Drawer({ open, onOpenChange, label, children }: { open: boolean; onOpenChange: (v: boolean) => void; label: string; children: ReactNode }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={overlay} />
        <DialogPrimitive.Content
          aria-label={label}
          aria-describedby={undefined}
          className="fixed inset-y-0 left-0 z-50 w-[min(86vw,320px)] bg-sidebar shadow-pop outline-none data-[state=open]:animate-in data-[state=open]:slide-in-from-left data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left"
        >
          <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/** Asks before something that cannot be undone. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirm,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: string
  children?: ReactNode
  confirm: string
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={children} hideClose className="sm:max-w-md">
        <DialogFooter className="border-t-0 pt-1 pb-4">
          <DialogClose asChild>
            <Button>取消</Button>
          </DialogClose>
          <Button
            variant="destructive"
            autoFocus
            onClick={() => {
              onOpenChange(false)
              onConfirm()
            }}
          >
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
