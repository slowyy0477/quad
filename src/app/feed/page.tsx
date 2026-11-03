import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { EndOfList, LoadMore, cursorHref } from '@/components/ui/pagination'
import { EmptyState, SectionHeading } from '@/components/ui/surface'
import { encodeCursor } from '@/lib/cursor'
import { isDataConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'
import { FeedLensTabs } from '@/features/feed/components/feed-lens-tabs'
import { PostCard } from '@/features/feed/components/post-card'
import { PostComposer } from '@/features/feed/components/post-composer'
import { getFeedPosts, listMyGoals, parseLens, type AttachOption } from '@/features/feed/queries'
import { listMyProjects } from '@/features/projects/queries'

export const metadata: Metadata = { title: 'Feed' }

type SearchParams = Record<string, string | string[] | undefined>

/**
 * The feed.
 *
 * proxy.ts already redirects a signed-out visitor away from this route, but the
 * check is repeated here. That is not belt-and-braces for its own sake: the proxy
 * is a convenience layer and its matcher is a regular expression that a future
 * edit could get subtly wrong, whereas this check runs in the same place the data
 * is read.
 *
 * **The lens is in the URL.** `?lens=following` is a real address, so a lens can be
 * bookmarked, shared and reached with the back button, and the server renders the
 * lens that was asked for rather than filtering a full list in the browser.
 * Anything that is not `following` is "For you", so a mangled value degrades to the
 * default lens instead of an error.
 *
 * **The cursor is in the URL too**, and it is opaque (base64url over
 * `created_at|id`), so a reader cannot usefully edit it and a truncated share
 * decodes to nothing. `decodeCursor` fails closed and the first page is shown —
 * which is a better answer than an error page for what is usually a typo.
 *
 * Nothing on this page is invented. If there are no posts the reader sees an empty
 * state saying why and offering one way forward, not a set of sample posts by
 * fictional students, and every number comes from a stored column.
 */
export default async function FeedPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  if (!isDataConfigured()) {
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

  const params = await searchParams
  const lens = parseLens(params.lens)

  const displayName =
    (typeof user.user_metadata?.display_name === 'string' ? user.user_metadata.display_name : null) ??
    user.email?.split('@')[0] ??
    'there'
  const firstName = displayName.split(' ')[0] ?? displayName

  const [feed, projects, goals] = await Promise.all([
    getFeedPosts({ lens, cursor: params.cursor }),
    listMyProjects(),
    listMyGoals(),
  ])

  const attachProjects: AttachOption[] = projects.map((project) => ({
    id: project.id,
    label: project.title,
    hint: project.visibility === 'private' ? 'Private project' : null,
  }))

  // Switching lens drops the cursor on purpose: a cursor is a position in one
  // ordering, and carrying it across would land the reader in the middle of a list
  // they never scrolled.
  const forYouHref = cursorHref('/feed', { ...params, lens: undefined }, null)
  const followingHref = cursorHref('/feed', { ...params, lens: 'following' }, null)
  const loadMoreHref = feed.nextCursor
    ? cursorHref('/feed', { ...params, lens }, encodeCursor(feed.nextCursor))
    : null

  return (
    <div className="page-enter mx-auto grid w-full max-w-6xl gap-8 px-4 py-8 sm:px-6 xl:grid-cols-[minmax(0,1fr)_15rem]">
      <div className="min-w-0 space-y-5">
        <SectionHeading
          level={1}
          title="Campus feed"
          description={
            lens === 'for-you'
              ? 'Student work, questions and updates. Share what’s on your mind.'
              : 'Posts from the accounts you follow, newest first.'
          }
        />

        <PostComposer authorFirstName={firstName} projects={attachProjects} goals={goals} />

        {feed.error ? <Alert tone="danger">{feed.error}</Alert> : null}

        <FeedLensTabs lens={lens} forYouHref={forYouHref} followingHref={followingHref}>
          {feed.posts && feed.posts.length > 0 ? (
            <>
              <div className="mt-5 space-y-4">
                {feed.posts.map((post) => (
                  <PostCard key={post.id} post={post} signedIn />
                ))}
              </div>

              {loadMoreHref ? <LoadMore href={loadMoreHref} /> : <EndOfList />}
            </>
          ) : null}

          {feed.posts && feed.posts.length === 0 ? (
            <EmptyState
              title={lens === 'for-you' ? 'Nothing here yet' : 'You are not following anyone yet'}
              action={
                <Link
                  href="/feed/people"
                  className="text-sm text-accent-700 underline underline-offset-2"
                >
                  Find people at your university
                </Link>
              }
            >
              {lens === 'for-you' ? (
                <p>
                  Share the first update, or find people whose work you want to follow.
                </p>
              ) : (
                <p>
                  Follow someone to see their updates here. Your campus is a good place to start.
                </p>
              )}
            </EmptyState>
          ) : null}
        </FeedLensTabs>
      </div>

      {/* Sidebar. Every item links to a real route. There were "soon" badges here,
          and they had gone stale: Messages, Projects and Goals were labelled as
          unbuilt while all three were working, which is worse than saying nothing.
          The status page is the single record of what works; this list does not
          try to keep a second copy of that truth. */}
      <aside className="hidden space-y-6 pt-2 xl:block">
        <section>
          <h2 className="text-base">Your work in progress</h2>
          {projects.length ? <ul className="mt-3 divide-y divide-hairline">{projects.slice(0, 3).map(project =>
            <li key={project.id}><Link href={`/projects/${project.slug}`} className="flex min-h-11 items-center py-2 text-sm font-medium text-accent-700">{project.title}</Link></li>)}</ul>
            : <p className="mt-3 text-sm text-ink-muted">You haven’t added a project yet. A small first idea is enough.</p>}
          <Link href="/projects/new" className="mt-3 flex min-h-11 items-center text-sm font-semibold text-accent-700">Start a project →</Link>
        </section>
        <section className="border-t border-rule pt-4">
          <h2 className="text-base">Make room to learn</h2>
          {goals.length ? <ul className="mt-3 space-y-2">{goals.slice(0, 3).map(goal => <li key={goal.id}><Link href="/goals" className="flex min-h-11 items-center text-sm text-ink-muted">{goal.label}</Link></li>)}</ul>
            : <p className="mt-3 text-sm text-ink-muted">Give the next thing you want to learn a place to start.</p>}
          <Link href="/goals" className="mt-2 flex min-h-11 items-center text-sm font-semibold text-accent-700">Your learning goals →</Link>
        </section>
      </aside>
    </div>
  )
}
