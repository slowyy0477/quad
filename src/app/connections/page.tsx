import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Alert } from '@/components/ui/alert'
import { EndOfList, LoadMore, cursorHref } from '@/components/ui/pagination'
import { StatRow } from '@/components/ui/stat-row'
import { EmptyState, SectionHeading } from '@/components/ui/surface'
import { ConnectionControls } from '@/features/connections/components/connection-controls'
import { PersonRow } from '@/features/connections/components/person-row'
import { UniversitySuggestions } from '@/features/connections/components/university-suggestions'
import { listConnections, listUniversitySuggestions } from '@/features/connections/queries'
import { getMyProfile } from '@/features/profiles/queries'
import { encodeCursor, nextCursor, parseCursor } from '@/lib/cursor'
import { isSupabaseConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'

const LIMIT = 25

type SearchParams = { cursor?: string | string[] }

/**
 * Your connections, and the people at your university.
 *
 * Both lists are built from real rows and nothing on this page is counted twice:
 * the three numbers in the stat row are the stored counters on the profile
 * (`connection_count`, `follower_count`, `following_count`), each maintained by a
 * trigger on the table it describes. They are not `count(*)` and they are not
 * recomputed here, so they cannot disagree with the profile page.
 *
 * The blocked disappear from both lists without a filter: `app.can_view_profile`
 * refuses a blocked profile, so the row those lists join against is not readable
 * in the first place.
 */
export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  if (!isSupabaseConfigured()) {
    return (
      <Alert tone="warning" title="No database connected">
        <p>
          Connections, follows and blocks are rows in Postgres. Without Supabase credentials there
          is nothing to list. <Link href="/setup">Configuration steps</Link>.
        </p>
      </Alert>
    )
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/connections')

  const params = await searchParams
  const cursor = parseCursor(params.cursor)

  const [profile, connections, suggestions] = await Promise.all([
    getMyProfile(),
    listConnections({ before: cursor?.createdAt, limit: LIMIT }),
    listUniversitySuggestions(),
  ])

  const counters = profile.state === 'ok' ? profile.profile : null
  const last = nextCursor(connections.items)
  const nextHref = last ? cursorHref('/connections', params, encodeCursor(last)) : null

  return (
    <div className="space-y-10">
      {counters ? (
        <SurfaceStats
          connections={counters.connection_count}
          followers={counters.follower_count}
          following={counters.following_count}
        />
      ) : null}

      <section aria-label="People from your university">
        <SectionHeading
          title={
            suggestions.universityName
              ? `People from ${suggestions.universityName}`
              : 'People from your university'
          }
          description="The students at your institution who have been active most recently. Not a ranking — it is their stored last-active time, newest first."
          className="border-b border-hairline"
        />

        {suggestions.error ? (
          <Alert tone="danger" className="mt-4">
            {suggestions.error}
          </Alert>
        ) : null}

        {suggestions.suggestions.length > 0 ? (
          <div className="mt-4">
            <UniversitySuggestions suggestions={suggestions.suggestions} />
          </div>
        ) : (
          <EmptyState
            className="mt-4"
            title={
              suggestions.universityName
                ? `Nobody else from ${suggestions.universityName} is here yet`
                : 'Your profile does not name a university'
            }
            action={
              <Link
                href="/universities"
                className="text-sm text-accent-700 underline underline-offset-2"
              >
                {suggestions.universityName ? 'Browse the directory' : 'Choose your university'}
              </Link>
            }
          >
            <p>
              {suggestions.universityName
                ? 'Either they have not joined, or their profiles are visible only to people they have accepted. Everyone at your institution is listed here as soon as they join.'
                : 'Pick your institution and the students there appear here, which is the fastest way to get a first connection.'}
            </p>
          </EmptyState>
        )}
      </section>

      <section aria-label="Your connections">
        <SectionHeading
          title="Your connections"
          description="People who accepted your request, or whose request you accepted."
          className="border-b border-hairline"
        />

        {connections.error ? (
          <Alert tone="danger" className="mt-4">
            {connections.error}
          </Alert>
        ) : null}

        {connections.items.length > 0 ? (
          <ul className="divide-y divide-hairline">
            {connections.items.map((item) => (
              <PersonRow
                key={item.id}
                person={item.person}
                meta={
                  <time dateTime={item.created_at}>
                    Connected{' '}
                    {new Date(item.created_at).toLocaleDateString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </time>
                }
              >
                {/* No control is rendered for a person the reader cannot see: there
                    is no name to put on the button and no row to act on. */}
                {item.person ? (
                  <ConnectionControls
                    profileId={item.person.id}
                    username={item.person.username}
                    displayName={item.person.display_name}
                    state="connected"
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
        ) : null}

        {connections.items.length === 0 && !connections.error ? (
          <EmptyState className="mt-4" title="You have not connected with anyone yet">
            <p>
              A connection starts from someone&rsquo;s profile, or from the people above if you
              share an institution with them. Either side has to accept before it counts.
            </p>
            <p className="mt-2">
              <Link href="/universities" className="text-accent-700 underline underline-offset-2">
                Find people at your university
              </Link>
            </p>
          </EmptyState>
        ) : null}

        {nextHref ? (
          <LoadMore href={nextHref} label="Load older connections" />
        ) : connections.items.length > 0 ? (
          <EndOfList label="No older connections." />
        ) : null}
      </section>
    </div>
  )
}

/** The reader's own stored counters, read from their profile row. */
function SurfaceStats({
  connections,
  followers,
  following,
}: {
  connections: number
  followers: number
  following: number
}) {
  return (
    <StatRow
      stats={[
        { label: 'Connections', value: connections },
        { label: 'Followers', value: followers },
        { label: 'Following', value: following },
      ]}
    />
  )
}
