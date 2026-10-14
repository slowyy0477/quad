'use client'

import * as SeparatorPrimitive from '@radix-ui/react-separator'
import { cn } from '@/lib/utils'

/**
 * Separator — the editorial rule, as a component.
 *
 * This design language separates content with rules rather than shadows, so this is
 * used more than a separator would be in a kit built on elevation. `decorative` (the
 * default) hides it from assistive technology, which is right for a visual break and
 * wrong for one that conveys a change of section — pass `decorative={false}` in that
 * case so it is announced as a separator.
 */
export function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      decorative={decorative}
      orientation={orientation}
      className={cn(
        'shrink-0 bg-rule',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  )
}
