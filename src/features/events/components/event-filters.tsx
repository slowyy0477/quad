import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Select } from '@/components/ui/input'
import { ATTENDANCE_MODES, EVENT_TYPES, attendanceModeLabel, eventTypeLabel } from '@/features/events/constants'

/**
 * The calendar filters.
 *
 * A plain GET form: it works before JavaScript, the filtered calendar is a shareable URL,
 * and it drops `cursor` for free -- a filter form does not post one, so changing a filter
 * starts at page one of the new result set instead of page two.
 */
export function EventFilters({
  lens,
  type,
  mode,
}: {
  lens: string
  type?: string
  mode?: string
}) {
  const filtered = Boolean(type || mode)

  return (
    <form method="get" action="/events" className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="lens" value={lens} />

      <Field id="event-filter-type" label="Kind of event" className="w-48">
        {(props) => (
          <Select {...props} name="type" defaultValue={type ?? ''}>
            <option value="">Any kind</option>
            {EVENT_TYPES.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <Field id="event-filter-mode" label="How to attend" className="w-40">
        {(props) => (
          <Select {...props} name="mode" defaultValue={mode ?? ''}>
            <option value="">Any way</option>
            {ATTENDANCE_MODES.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <Button type="submit" variant="secondary">
        Apply filters
      </Button>

      {filtered ? (
        <Button asChild variant="ghost">
          <a href={lens === 'past' ? '/events?lens=past' : '/events'}>Clear</a>
        </Button>
      ) : null}

      {filtered ? (
        <p className="w-full text-xs text-ink-muted" role="status">
          Showing {type ? eventTypeLabel(type) : 'any kind of event'}
          {mode ? ` · ${attendanceModeLabel(mode)}` : ''}.
        </p>
      ) : null}
    </form>
  )
}
