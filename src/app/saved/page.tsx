import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { LoadMore } from '@/components/ui/pagination'
import { EmptyState, SectionHeading } from '@/components/ui/surface'
import { PostCard } from '@/features/feed/components/post-card'
import { getSavedPosts } from '@/features/feed/queries'
import { isDataConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'

export const metadata: Metadata = { title: 'Saved posts', robots: { index: false, follow: false } }

export default async function SavedPage({
  searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!isDataConfigured()) return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-3xl">Saved posts</h1>
      <Alert tone="warning" className="mt-6">Saved posts are temporarily unavailable. <Link href="/help">Get help</Link>.</Alert>
    </div>
  )
  const user = await getUser()
  if (!user) redirect('/login?next=/saved')
  const query = await searchParams
  const result = await getSavedPosts({ cursor: query.cursor })
  return (
    <div className="page-enter mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
      <SectionHeading level={1} title="Saved posts"
        description="Your private bookmarks, newest saved first. Posts appear only while you can still read them."
        action={<Button asChild variant="secondary" size="sm"><Link href="/feed">Back to feed</Link></Button>} />
      {result.error ? <Alert tone="danger" className="mt-4">{result.error}</Alert> : null}
      <div className="mt-5 space-y-4">
        {result.posts?.map((post) => <PostCard key={post.id} post={post} signedIn />)}
        {!result.error && result.posts?.length === 0 ? (
          <EmptyState title="Nothing saved in this view">
            Save a post from the feed to come back to it here. A private or removed post may no longer appear.
          </EmptyState>
        ) : null}
      </div>
      {result.nextCursor ? <LoadMore href={`/saved?cursor=${encodeURIComponent(result.nextCursor)}`}
        label="Older saved posts" /> : null}
    </div>
  )
}
