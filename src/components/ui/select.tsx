'use client'

import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Select — a list of options that is not a `<select>`.
 *
 * The native element would be simpler and should be used when it suffices: it works
 * without JavaScript, is keyboard-perfect, and on a phone opens the OS picker. It stops
 * sufficing when an option needs a second line (a university and its city), when the
 * list is long enough to need filtering, or when the choice must render as something
 * richer than text. Those are the cases this is for; a plain five-item choice is not.
 *
 * The trigger is 44px tall on touch so it is not the one control on the page you
 * mis-tap, and the content is styled with the same rules as the rest of the interface
 * rather than the browser's own dropdown chrome.
 */
export const Select = SelectPrimitive.Root
export const SelectValue = SelectPrimitive.Value
export const SelectGroup = SelectPrimitive.Group

export function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        'flex min-h-11 w-full items-center justify-between gap-2 rounded border border-rule bg-paper-raised px-3 py-2 text-left text-sm text-ink',
        'hover:bg-paper-sunken data-[placeholder]:text-ink-faint',
        'disabled:pointer-events-none disabled:opacity-55',
        className,
      )}
      {...props}
    >
      <span className="min-w-0 truncate">{children}</span>
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

export function SelectContent({
  className,
  children,
  position = 'popper',
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        className={cn(
          'z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-rule bg-paper-raised shadow-float',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="max-h-72 overflow-y-auto p-1">
          {children}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

export function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        'relative flex cursor-default items-center rounded-sm py-2 pr-8 pl-2.5 text-sm text-ink outline-none select-none',
        'data-[highlighted]:bg-paper-sunken data-[disabled]:pointer-events-none data-[disabled]:opacity-55',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="absolute right-2.5 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-3.5 text-accent-600" aria-hidden="true" />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  )
}

export function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      className={cn('px-2.5 py-1.5 text-2xs font-semibold tracking-wide text-ink-faint uppercase', className)}
      {...props}
    />
  )
}
