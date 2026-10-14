'use client'

import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Dialog — a modal that interrupts deliberately.
 *
 * Radix supplies the parts that are easy to get wrong and expensive to get wrong:
 * focus trapped inside, focus returned to the trigger on close, `Esc` handled,
 * background scroll locked, and the title wired to `aria-labelledby`. A hand-rolled
 * modal passes review and then traps a keyboard user forever, which is why this exists
 * as a primitive rather than as a pattern in a document.
 *
 * On a phone it fills the screen. A centred 32rem panel on a 360px viewport leaves two
 * buttons competing for the same thumb-reach space, and the conventional fix — shrink
 * everything — produces a dialog whose close button is 24px from an edge.
 *
 * There is no animation here on purpose: the design language is print, motion utilities
 * are not installed, and the reduced-motion block in globals.css would disable them
 * anyway. A hard cut is honest and costs nothing.
 */
export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close
export const DialogPortal = DialogPrimitive.Portal

export function DialogContent({
  className,
  children,
  title,
  description,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  title: string
  description?: string
}) {
  return (
    <DialogPortal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-ink/45" />
      <DialogPrimitive.Content
        className={cn(
          'fixed z-50 flex flex-col bg-paper shadow-float',
          // Phone: the whole viewport. Larger: a panel with room to breathe.
          'inset-0 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:max-h-[85dvh] sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-md',
          'border border-rule',
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 border-b border-hairline px-5 py-4">
          <div className="min-w-0 space-y-1">
            <DialogPrimitive.Title className="font-display text-lg text-ink">
              {title}
            </DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="text-sm text-ink-muted">
                {description}
              </DialogPrimitive.Description>
            ) : null}
          </div>

          <DialogPrimitive.Close
            className="-m-1 rounded p-1 text-ink-muted hover:bg-paper-sunken hover:text-ink"
            aria-label="Close"
          >
            <X className="size-4" aria-hidden="true" />
          </DialogPrimitive.Close>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

export function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'mt-5 flex flex-col-reverse gap-2 border-t border-hairline pt-4 sm:flex-row sm:justify-end',
        className,
      )}
      {...props}
    />
  )
}
