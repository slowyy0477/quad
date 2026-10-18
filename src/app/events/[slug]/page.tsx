import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { CalendarClock, MapPin, Video } from 'lucide-react'
import { Alert } from '@/components/ui/alert'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { ProgressMeter } from '@/components/ui/progress-meter'
import { StatRow } from '@/components/ui/stat-row'
import { EmptyState, SectionHeading, Surface } from '@/components/ui/surface'
import { attendanceModeLabel, eventTypeLabel } from '@/features/events/constants'
import { RsvpControls } from '@/features/events/components/rsvp-controls'
import { getEventBySlug, getMyRsvp, listEventAttendees } from '@/features/events/queries'
import { eventHasPassed, formatEventWhen } from '@/features/events/when'
import { isSupabaseConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'

type Params = { slug: string }
type SearchParams = Record<string, string | string[] | undefined>

/**
 * The event page, and the metadata a shared link needs.
 *
 * The description is composed from the stored row — the title, and the first lines of the
 * description. Nothing is invented for a preview card.
 */
export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  if (!isSupabaseConfigured()) return { title: 'Event' }

  const { slug } = await params
  const event = await getEventBySlug(slug)
  if (!event) return { title: 'Event not found' }

  const when = formatEventWhen({
    startsAt: event.starts_at,
    endsAt: event.ends_at,
    timeZone: event.time_zone,
    isAllDay: event.is_all_day,
  })

  return {
    title: event.title,
    description: `${when} — ${event.description?.slice(0, 130) ?? event.title}`,
    openGraph: { type: 'article', title: event.title, description: when, url: `/events/${event.slug}` },
  }
}

/**
 * One event.
 *
 * The page answers four questions in the order someone asks them: when is it (in a stated
 * zone), can I come (capacity and RSVP), what is it, and where.
 *
 * Capacity is stated as a rule and not as a disabled control: when every place is taken the
 * page says how many places there are, how many are taken, and that "interested" is still
 * available because it does not consume one.
 */
export default async function EventPage({
  params,
  searchParams,
}: {
  params: Promise<Params>
  searchParams: Promise<SearchParams>
}) {
  if (!isSupabaseConfigured()) notFound()

  const { slug } = await params
  const event = await getEventBySlug(slug)
  if (!event) notFound()

  const query = await searchParams
  const user = await getUser()
  const now = new Date()

  const [myStatus, attendees] = await Promise.all([
    getMyRsvp(event.id),
    listEventAttendees(event.id),
  ])

  const cancelled = event.status === 'cancelled'
  const hasStarted = eventHasPassed(event.starts_at, now)
  const remaining = event.capacity == null ? null : Math.max(0, event.capacity - event.attendee_count)
  const moreAttendees = Math.max(0, event.attendee_count - attendees.length)

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      {query.created ? (
        <Alert tone="success" className="mb-5" title="The event is on the calendar">
          It appears under Upcoming until its start time passes, then under Past — the row is not deleted.
        </Alert>
      ) : null}

      {query.clamped ? (
        <Alert tone="info" className="mb-5" title="This event is less visible than you asked">
          The database clamps an event to the creator’s profile visibility, so a public event on a private
          profile is stored private. That rule is what stops a private profile from publishing a public
          page that names them.
        </Alert>
      ) : null}

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">{eventTypeLabel(event.type)}</Badge>
          <Badge tone="outline">{attendanceModeLabel(event.attendance_mode)}</Badge>
          {cancelled ? <Badge tone="danger">Cancelled</Badge> : null}
          {hasStarted && !cancelled ? <Badge tone="neutral">Past</Badge> : null}
          {event.visibility !== 'public' ? <Badge tone="outline">University only</Badge> : null}
          {remaining === 0 && !cancelled ? <Badge tone="neutral">Full</Badge> : null}
        </div>

        <h1 className="text-3xl text-ink">{event.title}</h1>

        <p className="flex items-start gap-2 text-lg text-ink-muted">
          <CalendarClock className="mt-1 size-5 shrink-0" aria-hidden="true" />
          <span>
            {formatEventWhen({
              startsAt: event.starts_at,
              endsAt: event.ends_at,
              timeZone: event.time_zone,
              isAllDay: event.is_all_day,
            })}
          </span>
        </p>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-ink-muted">
          {event.host ? (
            <Link
              href={`/u/${event.host.username}`}
              className="underline-offset-2 hover:text-ink hover:underline"
            >
              Organised by {event.host.display_name}
            </Link>
          ) : null}
          {event.university ? <span>{event.university.short_name ?? event.university.name}</span> : null}
          {event.project ? (
            <Link
              href={`/projects/${event.project.slug}`}
              className="underline-offset-2 hover:text-ink hover:underline"
            >
              Part of {event.project.title}
            </Link>
          ) : null}
        </div>
      </header>

      <Surface className="mt-6 p-5">
        <StatRow
          stats={[
            { label: 'Going', value: event.attendee_count },
            { label: 'Interested', value: event.interested_count },
            ...(event.capacity == null
              ? []
              : [{ label: 'Places', value: event.capacity, hint: 'capacity' }]),
          ]}
        />

        {event.capacity != null ? (
          <ProgressMeter
            className="mt-5"
            label="Places taken"
            value={event.attendee_count}
            total={event.capacity}
          />
        ) : (
          <p className="mt-4 text-sm text-ink-muted">
            No capacity limit: every RSVP is recorded, and none is refused for want of a place.
          </p>
        )}

        {attendees.length > 0 ? (
          <div className="mt-5 flex items-center gap-2 border-t border-hairline pt-4">
            <ul className="flex -space-x-2" aria-label="People going">
              {attendees.map((attendee) => (
                <li key={attendee.profile_id}>
                  <Avatar
                    name={attendee.profile?.display_name ?? 'Attendee'}
                    src={attendee.profile?.avatar_url ?? null}
                    size="xs"
                    className="ring-2 ring-paper-raised"
                  />
                </li>
              ))}
            </ul>
            <span className="text-xs text-ink-muted">
              {moreAttendees > 0
                ? `${event.attendee_count} going, including ${attendees.length} shown here`
                : `${event.attendee_count} going`}
            </span>
          </div>
        ) : null}
      </Surface>

      <section className="mt-8">
        <SectionHeading
          title="Your answer"
          description="An RSVP is a stored row: it survives a reload, and the organiser sees it."
        />
        <div className="mt-3">
          <RsvpControls
            eventId={event.id}
            slug={event.slug}
            myStatus={myStatus}
            isSignedIn={Boolean(user)}
            capacity={event.capacity}
            attendeeCount={event.attendee_count}
            cancelled={cancelled}
            hasStarted={hasStarted}
          />
        </div>
      </section>

      <section className="mt-8">
        <SectionHeading title="About this event" />
        {event.description ? (
          <p className="mt-3 max-w-prose text-sm whitespace-pre-wrap text-ink">{event.description}</p>
        ) : (
          <p className="mt-3 text-sm text-ink-muted">
            No description was written. The time and place above are all the organiser has given.
          </p>
        )}
      </section>

      <section className="mt-8">
        <SectionHeading title="Where" />
        <div className="mt-3 space-y-2 text-sm text-ink">
          {event.location ? (
            <p className="flex items-start gap-2">
              <MapPin className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
              <span>{event.location}</span>
            </p>
          ) : (
            <p className="text-ink-muted">
              No physical location. This is an {attendanceModeLabel(event.attendance_mode).toLowerCase()}{' '}
              event.
            </p>
          )}

          {event.location_url ? (
            <p>
              <a
                href={event.location_url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="inline-flex items-center gap-1.5 text-accent-700 underline underline-offset-2"
              >
                <MapPin className="size-4" aria-hidden="true" />
                Open the location
              </a>
            </p>
          ) : null}

          {event.join_url ? (
            <p>
              <a
                href={event.join_url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="inline-flex items-center gap-1.5 text-accent-700 underline underline-offset-2"
              >
                <Video className="size-4" aria-hidden="true" />
                Joining link
              </a>
            </p>
          ) : null}
        </div>
      </section>

      <section className="mt-8">
        <SectionHeading
          title="Who is going"
          description="Anyone who can see this event can see who is going. “Interested” is the quieter answer."
        />
        {attendees.length === 0 ? (
          <div className="mt-3">
            <EmptyState title="Nobody has said they are going yet">
              <p>
                The first RSVP appears here. If you would rather not be on this list, mark yourself
                interested instead — that does not take a place or put your name among the attendees.
              </p>
            </EmptyState>
          </div>
        ) : (
          <ul className="mt-2 divide-y divide-hairline">
            {attendees.map((attendee) => (
              <li key={attendee.profile_id} className="flex items-center gap-3 py-2.5">
                <Avatar
                  name={attendee.profile?.display_name ?? 'Attendee'}
                  src={attendee.profile?.avatar_url ?? null}
                  size="sm"
                />
                {attendee.profile ? (
                  <Link
                    href={`/u/${attendee.profile.username}`}
                    className="text-sm text-ink underline-offset-2 hover:underline"
                  >
                    {attendee.profile.display_name}
                  </Link>
                ) : (
                  <span className="text-sm text-ink-muted">A member</span>
                )}
              </li>
            ))}
          </ul>
        )}

        {moreAttendees > 0 ? (
          <p className="mt-3 text-xs text-ink-faint">
            <span className="tabular">{moreAttendees}</span> more going, not listed here.
          </p>
        ) : null}
      </section>

      <p className="mt-10 text-xs text-ink-faint">
        <Link href="/events" className="text-accent-700 underline underline-offset-2">
          All events
        </Link>
      </p>
    </div>
  )
}
