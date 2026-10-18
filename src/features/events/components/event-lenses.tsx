'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

/**
 * Upcoming and past, as URL-addressable tabs.
 *
 * The URL is the state: a tab that cannot be linked to or survive a reload is a tab users
 * stop trusting. Changing lens drops `cursor`, because a cursor from the ascending
 * "upcoming" ordering means nothing in the descending "past" one.
 */
export function EventLenses({
  lens,
  tabs,
}: {
  lens: string
  tabs: { value: string; label: string }[]
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  function onChange(value: string) {
    const params = new URLSearchParams(searchParams.toString())
    params.set('lens', value)
    params.delete('cursor')
    router.push(`${pathname}?${params.toString()}`, { scroll: false })
  }

  return (
    <Tabs value={lens} onValueChange={onChange}>
      <TabsList aria-label="Event lenses">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
