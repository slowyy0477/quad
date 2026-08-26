import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { EmptyState, SectionHeading } from '@/components/ui/surface'
import { PostCard } from '@/features/feed/components/post-card'
import { PostComposer } from '@/features/feed/components/post-composer'
import { getFeedPosts } from '@/features/feed/queries'
import { isSupabaseConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'

export const metadata: Metadata = { title: 'Feed' }

/**
 * The feed.
 *
 * proxy.ts already redirects a signed-out visitor away from this route, but the
 * check is repeated here. That is not belt-and-braces for its own sake: the proxy
 * is a convenience layer and its matcher is a regular expression that a future
 * edit could get subtly wrong, whereas this check runs in the same place the data
 * is read.
 *
 * Nothing on this page is invented. If there are no posts the reader sees an empty
 * state saying so, not a set of sample posts by fictional students.
 */
export default async function FeedPage() {
  if (!isSupabaseConfigured()) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-12">
        <h1 className="text-2xl">Feed</h1>
        <Alert tone="warning" title="No database connected" className="mt-5">
          <p>
            The feed reads real posts from Postgres. Without Supabase credentials there is nothing
            to read, and this page will not show made-up posts in their place.{' '}
            <Link href="/setup">Configuration steps</Link>.
          </p>
        </Alert>
      </div>
    )
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/feed')

  const displayName =
    (typeof user.user_metadata?.display_name === 'string' ? user.user_metadata.display_name : null) ??
    user.email?.split('@')[0] ??
    'there'
  const firstName = displayName.split(' ')[0] ?? displayName

  const { posts, error } = await getFeedPosts()

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <div className="min-w-0 space-y-5">
        <SectionHeading
          title="Your feed"
          description="Posts from people you follow and from your university, newest first."
        />

        <PostComposer authorFirstName={firstName} />

        {error ? <Alert tone="danger">{error}</Alert> : null}

        {posts && posts.length > 0 ? (
          <div className="space-y-4">
            {posts.map((post) => (
              <PostCard key={post.id} post={post} />
            ))}
          </div>
        ) : null}

        {posts && posts.length === 0 ? (
          <EmptyState title="Nothing here yet">
            <p>
              This is a new deployment, so there is genuinely nothing to show. Write the first post
              above, or find people to follow.
            </p>
          </EmptyState>
        ) : null}
      </div>

      {/* Sidebar. Every item links to a route; the ones whose feature is not
          finished say so rather than looking finished. */}
      <aside className="space-y-6 lg:border-l lg:border-hairline lg:pl-6">
        <nav aria-labelledby="feed-nav-heading">
          <h2
            id="feed-nav-heading"
            className="font-sans text-2xs font-semibold tracking-[0.12em] text-ink-faint uppercase"
          >
            Your Quad
          </h2>
          <ul className="mt-3 space-y-1 text-sm">
            {[
              { href: '/me', label: 'Your profile', ready: false },
              { href: '/projects', label: 'Projects', ready: false },
              { href: '/ideas', label: 'Ideas', ready: false },
              { href: '/messages', label: 'Messages', ready: false },
              { href: '/goals', label: 'Goals & study log', ready: false },
              { href: '/opportunities', label: 'Opportunities', ready: false },
              { href: '/events', label: 'Events', ready: false },
            ].map((item) => (
              <li key={item.href} className="flex items-center justify-between gap-2">
                <Link
                  href={item.href}
                  className="rounded py-1 text-ink-muted underline-offset-2 hover:text-ink hover:underline"
                >
                  {item.label}
                </Link>
                {!item.ready ? <Badge tone="outline">soon</Badge> : null}
              </li>
            ))}
          </ul>
        </nav>

        <div className="border-t border-hairline pt-4 text-xs text-ink-faint">
          <p>
            Quad is unfinished, and the{' '}
            <Link href="/status" className="text-accent-700 underline underline-offset-2">
              build status page
            </Link>{' '}
            lists exactly which parts work.
          </p>
        </div>
      </aside>
    </div>
  )
}
