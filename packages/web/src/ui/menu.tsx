import { Check } from 'lucide-react'
import { DropdownMenu as Menu, Popover as PopoverPrimitive } from 'radix-ui'
import type { ComponentProps } from 'react'
import { cn } from '../lib/cn'

export const DropdownMenu = Menu.Root
export const DropdownMenuTrigger = Menu.Trigger
export const DropdownMenuGroup = Menu.Group

const surface =
  'z-50 min-w-44 overflow-y-auto rounded-xl bg-popover p-1 text-sm shadow-pop outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-97 data-[state=closed]:animate-out data-[state=closed]:fade-out-0'
const item =
  'flex min-h-8 items-center gap-2 rounded-lg px-2.5 py-1.5 outline-none select-none data-[highlighted]:bg-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0'

export function DropdownMenuContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content sideOffset={sideOffset} collisionPadding={8} className={cn(surface, 'max-h-(--radix-dropdown-menu-content-available-height)', className)} {...props} />
    </Menu.Portal>
  )
}

export function DropdownMenuItem({ className, destructive, ...props }: ComponentProps<typeof Menu.Item> & { destructive?: boolean }) {
  return <Menu.Item className={cn(item, destructive && 'text-destructive data-[highlighted]:bg-destructive-soft', className)} {...props} />
}

export function DropdownMenuCheckItem({ className, children, checked, ...props }: ComponentProps<typeof Menu.Item> & { checked: boolean }) {
  return (
    <Menu.Item role="menuitemradio" aria-checked={checked} className={cn(item, className)} {...props}>
      <span className="min-w-0 flex-1">{children}</span>
      {checked && <Check className="text-accent" />}
    </Menu.Item>
  )
}

export const DropdownMenuLabel = ({ className, ...props }: ComponentProps<typeof Menu.Label>) => (
  <Menu.Label className={cn('px-2.5 pt-2 pb-1 text-xs text-muted-foreground', className)} {...props} />
)
export const DropdownMenuSeparator = ({ className, ...props }: ComponentProps<typeof Menu.Separator>) => <Menu.Separator className={cn('mx-1 my-1 h-px bg-border', className)} {...props} />

export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverAnchor = PopoverPrimitive.Anchor
export const PopoverClose = PopoverPrimitive.Close

export function PopoverContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content sideOffset={sideOffset} collisionPadding={8} className={cn(surface, 'max-h-(--radix-popover-content-available-height) p-3', className)} {...props} />
    </PopoverPrimitive.Portal>
  )
}
