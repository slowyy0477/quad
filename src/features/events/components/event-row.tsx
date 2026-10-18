import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Surface } from '@/components/ui/surface'
import { attendanceModeLabel, eventTypeLabel, rsvpLabel } from '@/features/events/constants'
import { formatEventDay, formatEventTime } from '@/features/events/when'
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

  return (
    <Surface as="article" className="p-4 transition-colors hover:border-rule">
      <div className="flex items-start justify-between gap-3">
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

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {event.myStatus ? <Badge tone="accent">{rsvpLabel(event.myStatus)}</Badge> : null}
          {full ? <Badge tone="neutral">Full</Badge> : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Badge tone="neutral">{eventTypeLabel(event.type)}</Badge>
        <Badge tone="outline">{attendanceModeLabel(event.attendance_mode)}</Badge>
        {event.location ? <Badge tone="outline">{event.location}</Badge> : null}
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
