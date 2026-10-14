'use client'

import * as SwitchPrimitive from '@radix-ui/react-switch'
import { cn } from '@/lib/utils'

/**
 * Switch — a setting that takes effect immediately.
 *
 * A switch is not a checkbox. A checkbox is a value you submit with a form ("include my
 * email on my profile"); a switch is a state that changes as you flip it ("dark mode").
 * Using one for the other means the user cannot tell whether the change has happened
 * yet, which is the single most common accessibility complaint about settings pages.
 */
export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'peer inline-flex h-6 w-10 shrink-0 items-center rounded-full border border-rule bg-paper-sunken',
        'transition-colors duration-150 ease-out-soft',
        'data-[state=checked]:border-accent-700 data-[state=checked]:bg-accent-600',
        'disabled:pointer-events-none disabled:opacity-55',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block size-4.5 rounded-full bg-paper-raised border border-hairline',
          'transition-transform duration-150 ease-out-soft',
          'translate-x-0.5 data-[state=checked]:translate-x-4.5',
        )}
      />
    </SwitchPrimitive.Root>
  )
}
