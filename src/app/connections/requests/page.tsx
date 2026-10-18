import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { EndOfList, LoadMore, cursorHref } from '@/components/ui/pagination'
import { EmptyState, SectionHeading } from '@/components/ui/surface'
import { ConnectionControls } from '@/features/connections/components/connection-controls'
import { PersonRow } from '@/features/connections/components/person-row'
import { listRequests } from '@/features/connections/queries'
import { encodeCursor, nextCursor, parseCursor } from '@/lib/cursor'
import { isSupabaseConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'

export const metadata: Metadata = { title: 'Connection requests' }

const LIMIT = 25

type SearchParams = { cursor?: string | string[] }

/**
 * Requests, in both directions.
 *
 * The two lists share one cursor, and that is a decision rather than a shortcut:
 * "Load older requests" moves the window over the reader's requests as a whole, so
 * a section that has run out says so while the other carries on. The alternative —
 * a cursor each — would mean two "Load more" controls on one page, which reads as
 * two different pages.
 *
 * The incoming list carries the answer controls, because answering is the one
 * thing this page exists for. The outgoing list carries only withdrawal: a request
 * the reader sent is not theirs to accept.
 */
export default async function ConnectionRequestsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  if (!isSupabaseConfigured()) {
    return (
      <Alert tone="warning" title="No database connected">
        <p>
          Requests are rows in Postgres. Without Supabase credentials there is nothing to answer.{' '}
          <Link href="/setup">Configuration steps</Link>.
        </p>
      </Alert>
    )
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/connections/requests')

  const params = await searchParams
  const cursor = parseCursor(params.cursor)

  const { incoming, outgoing, error } = await listRequests({
    before: cursor?.createdAt,
    limit: LIMIT,
  })

  const last = nextCursor(incoming)
  const nextHref = last ? cursorHref('/connections/requests', params, encodeCursor(last)) : null

  return (
    <div className="space-y-10">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <section aria-label="Requests waiting for you">
        <SectionHeading
          title="Waiting for you"
          description="People who have asked to connect. Accepting is mutual; declining keeps the record so they cannot ask again automatically."
          className="border-b border-hairline"
        />

        {incoming.length > 0 ? (
          <ul className="divide-y divide-hairline">
            {incoming.map((item) => (
              <PersonRow
                key={item.id}
                person={item.person}
                meta={
                  <>
                    <time dateTime={item.created_at}>
                      Asked{' '}
                      {new Date(item.created_at).toLocaleDateString('en-GB', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </time>
                    {/* The note is a column on the request row, so it is shown or it
                        is absent. It is never invented, and a request without one
                        says nothing rather than something generic. */}
                    {item.message ? <p className="mt-1 text-ink-muted">“{item.message}”</p> : null}
                  </>
                }
              >
                {item.person ? (
                  <ConnectionControls
                    profileId={item.person.id}
                    username={item.person.username}
                    displayName={item.person.display_name}
                    state="incoming"
                    connectionId={item.id}
                    isFollowing={false}
                    isBlockingThem={false}
                    signedIn
                    showFollow={false}
                    size="sm"
                  />
                ) : null}
              </PersonRow>
            ))}
          </ul>
        ) : (
          <EmptyState className="mt-4" title="Nothing is waiting for you">
            <p>
              Requests people send you arrive here. Until someone asks, there is nothing to answer —
              you can ask first from anyone&rsquo;s profile.
            </p>
          </EmptyState>
        )}
      </section>

      <section aria-label="Requests you have sent">
        <SectionHeading
          title="You asked"
          description="Waiting for an answer. A request can be withdrawn at any time, and withdrawing tells the other person nothing."
          className="border-b border-hairline"
        />

        {outgoing.length > 0 ? (
          <ul className="divide-y divide-hairline">
            {outgoing.map((item) => (
              <PersonRow
                key={item.id}
                person={item.person}
                meta={
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone="neutral">No answer yet</Badge>
                    <time dateTime={item.created_at}>
                      Sent{' '}
                      {new Date(item.created_at).toLocaleDateString('en-GB', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </time>
                  </span>
                }
              >
                {item.person ? (
                  <ConnectionControls
                    profileId={item.person.id}
                    username={item.person.username}
                    displayName={item.person.display_name}
                    state="outgoing"
                    connectionId={item.id}
                    isFollowing={false}
                    isBlockingThem={false}
                    signedIn
                    showFollow={false}
                    size="sm"
                  />
                ) : null}
              </PersonRow>
            ))}
          </ul>
        ) : (
          <EmptyState className="mt-4" title="You have not asked anyone">
            <p>
              A request is how a connection starts. It is one-sided until they accept, and they can
              decline without either of you being told why.
            </p>
            <p className="mt-2">
              <Link
                href="/connections"
                className="text-accent-700 underline underline-offset-2"
              >
                See people at your university
              </Link>
            </p>
          </EmptyState>
        )}
      </section>

      {nextHref ? (
        <LoadMore href={nextHref} label="Load older requests" />
      ) : incoming.length > 0 || outgoing.length > 0 ? (
        <EndOfList label="No older requests." />
      ) : null}
    </div>
  )
}
