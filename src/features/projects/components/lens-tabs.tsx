'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

/**
 * The two project lenses, as URL-addressable tabs.
 *
 * Radix supplies the arrow-key navigation; the URL is the state. A tab that cannot be
 * linked to or survive a reload is a tab users stop trusting (UX.md §3), so changing
 * the value pushes `?lens=…` and the server re-renders the lens that was asked for.
 * The cursor is dropped on a lens change, because a page-two cursor from one lens is
 * meaningless in the other.
 */
export function LensTabs({
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
      <TabsList aria-label="Project lenses">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
