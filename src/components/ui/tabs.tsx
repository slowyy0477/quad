'use client'

import * as TabsPrimitive from '@radix-ui/react-tabs'
import { cn } from '@/lib/utils'

/**
 * Tabs — the same data seen two ways.
 *
 * Used for lenses that are genuinely parallel (For you / Following, My projects / Open
 * to join), never to hide content that belongs on one page. Radix provides the
 * arrow-key navigation and the `tab`/`tabpanel` relationship; the caller provides the
 * URL state, because a tab that cannot be linked to or survive a reload is a tab users
 * will stop trusting.
 *
 * The active tab is marked with a rule rather than a filled pill: a filled pill is a
 * button, and this is a position in a list.
 */
export const Tabs = TabsPrimitive.Root

export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn('flex items-center gap-1 border-b border-rule', className)}
      {...props}
    />
  )
}

export function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        '-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-ink-muted',
        'hover:text-ink',
        'data-[state=active]:border-accent-600 data-[state=active]:text-ink',
        'focus-visible:outline-2',
        className,
      )}
      {...props}
    />
  )
}

export function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('pt-5 outline-none', className)} {...props} />
}
