import Link from 'next/link'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { EndOfList, LoadMore, cursorHref } from '@/components/ui/pagination'
import { EmptyState, SectionHeading } from '@/components/ui/surface'
import { EventFilters } from '@/features/events/components/event-filters'
import { EventLenses } from '@/features/events/components/event-lenses'
import { EventRow } from '@/features/events/components/event-row'
import { listEvents, type EventPage } from '@/features/events/queries'
import { isSupabaseConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'

export const metadata: Metadata = { title: 'Events' }

type SearchParams = Record<string, string | string[] | undefined>

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * The campus calendar: upcoming and past, split on `starts_at`.
 *
 * The split is a real boundary rather than a label: "upcoming" is `starts_at >= now` at
 * the moment the page was rendered, so an event moves from one list to the other by
 * itself, with no job to run and nothing to remember. Past events stay readable, because a
 * calendar that deletes its own history is not a calendar.
 *
 * Cancelled events appear in neither list — they are not things to turn up to — and their
 * pages still exist for anyone holding the link, saying plainly that they were cancelled.
 */
export default async function EventsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  if (!isSupabaseConfigured()) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-12">
        <h1 className="text-2xl">Events</h1>
        <Alert tone="warning" title="No database connected" className="mt-5">
          <p>
            The calendar is read from Postgres. Without Supabase credentials there is nothing to read, and
            this page will not show invented events in their place. <Link href="/setup">Configuration steps</Link>.
          </p>
        </Alert>
      </div>
    )
  }

  const params = await searchParams
  const user = await getUser()

  const lens = first(params.lens) === 'past' ? 'past' : 'upcoming'
  const type = first(params.type)
  const mode = first(params.mode)

  // One clock for the split and for every row on the page.
  const now = new Date()

  const page: EventPage = await listEvents({ lens, type, mode, cursor: params.cursor, now })

  const filtered = Boolean(type || mode)

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <SectionHeading
        title="Events"
        description="Workshops, hackathons, talks and study groups on campus and online. Times are shown in each event's own zone."
        action={
          user ? (
            <Button asChild variant="primary" size="sm">
              <Link href="/events/new">Create an event</Link>
            </Button>
          ) : (
            <Button asChild variant="secondary" size="sm">
              <Link href="/login?next=/events/new">Sign in to create</Link>
            </Button>
          )
        }
      />

      <div className="mt-5">
        <EventLenses
          lens={lens}
          tabs={[
            { value: 'upcoming', label: 'Upcoming' },
            { value: 'past', label: 'Past' },
          ]}
        />
      </div>

      <p className="mt-3 text-xs text-ink-muted">
        {lens === 'upcoming'
          ? 'Sorted by start time, soonest first.'
          : 'Sorted by start time, most recent first. An event moves here once it has started.'}
      </p>

      <div className="mt-5">
        <EventFilters lens={lens} type={type} mode={mode} />
      </div>

      {page.error ? (
        <Alert tone="danger" className="mt-5">
          {page.error}
        </Alert>
      ) : null}

      {page.events.length === 0 ? (
        <div className="mt-6">
          {filtered ? (
            <EmptyState
              title="Nothing matches those filters"
              action={
                <Button asChild variant="secondary">
                  <Link href={lens === 'past' ? '/events?lens=past' : '/events'}>Clear the filters</Link>
                </Button>
              }
            >
              <p>
                No {lens === 'past' ? 'past' : 'upcoming'} event matches that kind and way of attending
                together. Widening the filters is the quickest way back to the calendar.
              </p>
            </EmptyState>
          ) : lens === 'past' ? (
            <EmptyState
              title="Nothing has happened yet"
              action={
                <Button asChild variant="secondary">
                  <Link href="/events">See what is coming up</Link>
                </Button>
              }
            >
              <p>
                An event appears here once its start time has passed. Until then it is on the upcoming
                list.
              </p>
            </EmptyState>
          ) : (
            <EmptyState
              title="No event is coming up"
              action={
                user ? (
                  <Button asChild variant="primary">
                    <Link href="/events/new">Create the first event</Link>
                  </Button>
                ) : (
                  <Button asChild variant="primary">
                    <Link href="/login?next=/events/new">Sign in to create one</Link>
                  </Button>
                )
              }
            >
              <p>
                This calendar is empty because nobody has put anything on it yet. A study group with a
                time and a room is enough to start.
              </p>
            </EmptyState>
          )}
        </div>
      ) : (
        <>
          <ul className="mt-5 space-y-4">
            {page.events.map((event) => (
              <li key={event.id}>
                <EventRow event={event} />
              </li>
            ))}
          </ul>

          {page.nextCursor ? (
            <LoadMore href={cursorHref('/events', params, page.nextCursor)} label="Load more events" />
          ) : (
            <EndOfList
              label={lens === 'upcoming' ? 'That is every upcoming event.' : 'That is the whole history.'}
            />
          )}
        </>
      )}
    </div>
  )
}
