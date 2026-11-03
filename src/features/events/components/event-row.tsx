import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Surface } from '@/components/ui/surface'
import { attendanceModeLabel, eventTypeLabel, rsvpLabel } from '@/features/events/constants'
import { formatEventDay, formatEventTime, safeZone } from '@/features/events/when'
import type { EventBoardRow } from '@/features/events/queries'

/**
 * One event in a list.
 *
 * The time is printed with its zone name, not as a bare clock -- a reader in Karachi
 * looking at an event organised in London needs to know which 14:00 it is, and that is
 * exactly what `time_zone` is stored for.
 *
 * Both counts are trigger-maintained columns over `event_attendees`; the capacity is the
 * stored limit, `null` meaning none. When there is a limit the row says how many places are
 * left, because "12 going" alone does not tell anyone whether they can come.
 */
export function EventRow({ event }: { event: EventBoardRow }) {
  const remaining = event.capacity == null ? null : Math.max(0, event.capacity - event.attendee_count)
  const full = remaining === 0
  const dateParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: safeZone(event.time_zone), day: 'numeric', month: 'short',
  }).formatToParts(new Date(event.starts_at))
  const day = dateParts.find(part => part.type === 'day')?.value
  const month = dateParts.find(part => part.type === 'month')?.value

  return (
    <Surface as="article" className="interactive-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-4">
          <div className="event-date-tile hidden sm:flex" aria-hidden="true">
            <span className="text-xs font-semibold uppercase">{month}</span>
            <span className="text-2xl font-bold tabular-nums">{day}</span>
          </div>
          <div className="min-w-0">
          <p className="text-2xs font-semibold tracking-[0.12em] text-ink-faint uppercase">
            {formatEventDay(event.starts_at, event.time_zone)}
          </p>
          <h3 className="mt-1 text-base leading-snug">
            <Link href={`/events/${event.slug}`} className="text-ink underline-offset-2 hover:underline">
              {event.title}
            </Link>
          </h3>
          <p className="mt-1 text-sm text-ink-muted tabular">
            {event.is_all_day ? 'All day' : formatEventTime(event.starts_at, event.time_zone)}
          </p>
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {event.myStatus ? <Badge tone="accent">{rsvpLabel(event.myStatus)}</Badge> : null}
          {full ? <Badge tone="neutral">Full</Badge> : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
        <span>{eventTypeLabel(event.type)}</span>
        <span className="border-l border-rule pl-3">{attendanceModeLabel(event.attendance_mode)}</span>
        {event.location ? <span>{event.location}</span> : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-3 text-xs text-ink-muted">
        <p>
          <span className="tabular">{event.attendee_count}</span>{' '}
          {event.attendee_count === 1 ? 'person going' : 'people going'}
          {event.interested_count > 0 ? (
            <>
              {' · '}
              <span className="tabular">{event.interested_count}</span> interested
            </>
          ) : null}
        </p>

        <p className="text-ink-faint">
          {event.capacity == null ? (
            'No capacity limit'
          ) : full ? (
            <>
              Full — <span className="tabular">{event.attendee_count}</span> of{' '}
              <span className="tabular">{event.capacity}</span> places taken
            </>
          ) : (
            <>
              <span className="tabular">{remaining}</span> of{' '}
              <span className="tabular">{event.capacity}</span> places left
            </>
          )}
        </p>
      </div>
    </Surface>
  )
}
