'use client'

import { useRouter } from 'next/navigation'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { FeedLens } from '@/features/feed/queries'

/**
 * The two feed lenses, as URL-addressable tabs.
 *
 * The lens lives in the query string, not in component state, so a lens can be
 * linked, bookmarked and reached with the back button — a tab that cannot be
 * linked to is a tab users stop trusting. The hrefs are built on the server and
 * passed in, which keeps `useSearchParams` (and its Suspense requirements) out of
 * this component entirely.
 *
 * Radix supplies the arrow-key navigation and the `tab`/`tabpanel` relationship;
 * what it does not supply is where the state lives, and that is the decision here.
 *
 * The panel content is server-rendered and passed as children: the tab list is the
 * only thing that has to be interactive, so the posts themselves never ship to the
 * browser as client JavaScript.
 */
export function FeedLensTabs({
  lens,
  forYouHref,
  followingHref,
  children,
}: {
  lens: FeedLens
  forYouHref: string
  followingHref: string
  children: React.ReactNode
}) {
  const router = useRouter()

  return (
    <Tabs
      value={lens}
      onValueChange={(value) => {
        // `scroll={false}` so switching lens does not jump the reader to the top
        // of a list they were halfway down — the browser's back button still
        // returns them exactly where they were.
        router.push(value === 'following' ? followingHref : forYouHref, { scroll: false })
      }}
    >
      <TabsList aria-label="Which feed">
        <TabsTrigger value="for-you">For you</TabsTrigger>
        <TabsTrigger value="following">Following</TabsTrigger>
      </TabsList>
      <TabsContent value={lens}>{children}</TabsContent>
    </Tabs>
  )
}
