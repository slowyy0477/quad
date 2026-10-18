import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { EndOfList, LoadMore, cursorHref } from '@/components/ui/pagination'
import { EmptyState, SectionHeading } from '@/components/ui/surface'
import { ConnectionControls } from '@/features/connections/components/connection-controls'
import { PersonRow } from '@/features/connections/components/person-row'
import { listFollows, listMyGraphState } from '@/features/connections/queries'
import { encodeCursor, nextCursor, parseCursor } from '@/lib/cursor'
import { isSupabaseConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'

export const metadata: Metadata = { title: 'Followers' }

const LIMIT = 25

type SearchParams = { cursor?: string | string[] }

/**
 * Followers, and the people this reader follows.
 *
 * Following is one-directional and asks for nothing, so the control on each row is
 * whatever actually applies: someone already connected shows a Connected badge,
 * someone with a pending request shows nothing that would duplicate it, and
 * everybody else can be asked. That state comes from `listMyGraphState`, which is
 * one read for the whole page rather than a query per row.
 *
 * Both lists move together on one cursor, for the reason given on the requests
 * page: one "Load more" per page, not two.
 */
export default async function FollowersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  if (!isSupabaseConfigured()) {
    return (
      <Alert tone="warning" title="No database connected">
        <p>
          Follows are rows in Postgres. Without Supabase credentials there is nothing to list.{' '}
          <Link href="/setup">Configuration steps</Link>.
        </p>
      </Alert>
    )
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/connections/followers')

  const params = await searchParams
  const cursor = parseCursor(params.cursor)

  const [following, followers, graph] = await Promise.all([
    listFollows({ direction: 'following', before: cursor?.createdAt, limit: LIMIT }),
    listFollows({ direction: 'followers', before: cursor?.createdAt, limit: LIMIT }),
    listMyGraphState(),
  ])

  const last = nextCursor(following.items)
  const nextHref = last ? cursorHref('/connections/followers', params, encodeCursor(last)) : null

  const error = following.error ?? followers.error

  return (
    <div className="space-y-10">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <section aria-label="People you follow">
        <SectionHeading
          title="People you follow"
          description="A follow is one-directional. They are not asked, and nothing is sent to them."
          className="border-b border-hairline"
        />

        {following.items.length > 0 ? (
          <ul className="divide-y divide-hairline">
            {following.items.map((item) => (
              <PersonRow key={item.id} person={item.person}>
                {item.person ? (
                  <ConnectionControls
                    profileId={item.person.id}
                    username={item.person.username}
                    displayName={item.person.display_name}
                    state={graph.connectionStates.get(item.person.id) ?? 'none'}
                    connectionId={null}
                    isFollowing={graph.following.has(item.person.id)}
                    isBlockingThem={false}
                    signedIn
                    size="sm"
                  />
                ) : null}
              </PersonRow>
            ))}
          </ul>
        ) : (
          <EmptyState className="mt-4" title="You are not following anyone">
            <p>
              Following is the lightest way to keep up with someone: no request, no answer needed.
              It starts from a profile.
            </p>
            <p className="mt-2">
              <Link href="/connections" className="text-accent-700 underline underline-offset-2">
                See people at your university
              </Link>
            </p>
          </EmptyState>
        )}
      </section>

      <section aria-label="People who follow you">
        <SectionHeading
          title="People who follow you"
          description="They see the posts your profile visibility allows. You are not told who unfollows."
          className="border-b border-hairline"
        />

        {followers.items.length > 0 ? (
          <ul className="divide-y divide-hairline">
            {followers.items.map((item) => (
              <PersonRow key={item.id} person={item.person}>
                {item.person ? (
                  <ConnectionControls
                    profileId={item.person.id}
                    username={item.person.username}
                    displayName={item.person.display_name}
                    state={graph.connectionStates.get(item.person.id) ?? 'none'}
                    connectionId={null}
                    isFollowing={graph.following.has(item.person.id)}
                    isBlockingThem={false}
                    signedIn
                    size="sm"
                  />
                ) : null}
              </PersonRow>
            ))}
          </ul>
        ) : (
          <EmptyState className="mt-4" title="Nobody follows you yet">
            <p>
              People find you through your university, your projects and the feed. Connecting with
              someone usually leads to a follow, and following is not the same as connecting.
            </p>
            <p className="mt-2">
              <Link href="/me/edit" className="text-accent-700 underline underline-offset-2">
                Check what your profile shows
              </Link>
            </p>
          </EmptyState>
        )}
      </section>

      {nextHref ? (
        <LoadMore href={nextHref} label="Load older follows" />
      ) : following.items.length > 0 || followers.items.length > 0 ? (
        <EndOfList label="No older follows." />
      ) : null}
    </div>
  )
}
