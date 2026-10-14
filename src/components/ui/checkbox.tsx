'use client'

import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Checkbox — a value that is submitted, or a choice among several.
 *
 * Always rendered with a visible label; the label is part of the control's target, not
 * a `<span>` beside it, so the whole row is clickable and a screen reader announces one
 * thing rather than two.
 */
export function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-sm border border-rule bg-paper-raised',
        'data-[state=checked]:border-accent-700 data-[state=checked]:bg-accent-600 data-[state=checked]:text-white',
        'disabled:pointer-events-none disabled:opacity-55',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator>
        <Check className="size-3.5" aria-hidden="true" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}
