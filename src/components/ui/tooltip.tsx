'use client'

import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { cn } from '@/lib/utils'

/**
 * Tooltip — the label for a control that has no visible one.
 *
 * Only for controls whose meaning is carried by an icon. A tooltip is never the only
 * label: it does not appear on touch, it does not appear on keyboard focus in every
 * browser, and it is invisible to anyone who does not hover. Icon-only buttons
 * therefore still carry an `aria-label`, and this adds to that rather than replacing it.
 */
export const TooltipProvider = TooltipPrimitive.Provider
export const Tooltip = TooltipPrimitive.Root
export const TooltipTrigger = TooltipPrimitive.Trigger

export function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 max-w-64 rounded border border-rule bg-ink px-2 py-1 text-xs text-paper shadow-float',
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  )
}
