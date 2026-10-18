'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

/**
 * The two board lenses, as URL-addressable tabs.
 *
 * The URL is the state: a filtered, lensed board is a link someone can send, and a tab
 * survives a reload. Changing lens drops `cursor`, because a page-two cursor from one
 * ordering is meaningless in the other.
 */
export function BoardLenses({
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
      <TabsList aria-label="Opportunity board">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
