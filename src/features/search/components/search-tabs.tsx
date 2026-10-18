'use client'

import { useRouter } from 'next/navigation'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { SearchKind } from '@/features/search/queries'

/**
 * The result kinds, as URL-addressable tabs.
 *
 * The same arrangement as the feed's lens tabs, for the same reasons: the kind
 * lives in the query string rather than in component state, so a tab can be linked,
 * bookmarked and reached with the back button, and the server renders the kind that
 * was asked for instead of filtering a full list in the browser. The hrefs are built
 * on the server and passed in, which keeps `useSearchParams` and its Suspense
 * requirements out of this component.
 *
 * Radix supplies the arrow-key navigation and the `tab`/`tabpanel` relationship.
 * The panel's content is server-rendered and passed as children, so six kinds of
 * result do not become six kinds of client JavaScript.
 *
 * The tab list wraps rather than scrolls: six labels do not fit across 360 px, and a
 * horizontally scrolling tab strip hides the tabs a phone user has not found yet.
 */
export function SearchTabs({
  value,
  tabs,
  children,
}: {
  value: SearchKind
  tabs: readonly { value: SearchKind; label: string; href: string }[]
  children: React.ReactNode
}) {
  const router = useRouter()

  return (
    <Tabs
      value={value}
      onValueChange={(next) => {
        const tab = tabs.find((candidate) => candidate.value === next)
        // `scroll={false}` so changing kind does not jump the reader to the top of a
        // list they were reading; the back button still returns them exactly.
        if (tab) router.push(tab.href, { scroll: false })
      }}
    >
      <TabsList aria-label="Which kind of result" className="flex-wrap">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value={value}>{children}</TabsContent>
    </Tabs>
  )
}
