'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Checkbox } from '@/components/ui/checkbox'
import { Field } from '@/components/ui/field'
import { Input, Select, Textarea } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import {
  ATTENDANCE_MODES,
  EVENT_TYPES,
  EVENT_VISIBILITIES,
  TIME_ZONE_OPTIONS,
} from '@/features/events/constants'
import { createEventAction } from '@/features/events/actions'
import { emptyFormState } from '@/lib/form-state'

/**
 * Put an event on the calendar.
 *
 * The time fields are `datetime-local`, which is a wall clock with no zone — so the form
 * asks for the zone beside them and the action converts the pair into a real instant with
 * that zone's own offset. The alternative, a UTC time field, is a trap: nobody knows what
 * 09:00Z is.
 *
 * The organiser is the session, never a field; `events_before_write` sets `created_by`, the
 * slug, the counters, and clamps the visibility to their profile.
 */
export function NewEventForm() {
  const [state, action] = useActionState(createEventAction, emptyFormState)
  const values = state.values ?? {}

  return (
    <form action={action} className="space-y-5">
      {state.status === 'error' && state.message ? (
        <Alert tone="danger" title="The event was not saved">
          {state.message}
        </Alert>
      ) : null}

      <Field
        id="event-title"
        label="Title"
        required
        hint="What it is, in the words people would use to talk about it."
        error={state.fieldErrors?.title}
      >
        {(props) => (
          <Input {...props} name="title" defaultValue={values.title} maxLength={160} autoComplete="off" />
        )}
      </Field>

      <Field
        id="event-description"
        label="Description"
        hint="What happens, who it is for, and anything to bring."
        error={state.fieldErrors?.description}
      >
        {(props) => (
          <Textarea {...props} name="description" rows={6} defaultValue={values.description} maxLength={10000} />
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="event-type" label="Kind of event" required error={state.fieldErrors?.type}>
          {(props) => (
            <Select {...props} name="type" defaultValue={values.type ?? 'workshop'}>
              {EVENT_TYPES.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field id="event-mode" label="How to attend" required error={state.fieldErrors?.attendanceMode}>
          {(props) => (
            <Select {...props} name="attendanceMode" defaultValue={values.attendanceMode ?? 'onsite'}>
              {ATTENDANCE_MODES.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field
          id="event-zone"
          label="Time zone"
          required
          hint="The clock the times below are in. It is printed with the event so nobody has to guess."
          error={state.fieldErrors?.timeZone}
        >
          {(props) => (
            <Select {...props} name="timeZone" defaultValue={values.timeZone ?? 'Asia/Karachi'}>
              {TIME_ZONE_OPTIONS.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field
          id="event-capacity"
          label="Capacity"
          hint="Optional. Leave empty for no limit — the database only refuses an RSVP when a limit is stored."
          error={state.fieldErrors?.capacity}
        >
          {(props) => (
            <Input
              {...props}
              name="capacity"
              type="number"
              min={1}
              max={100000}
              inputMode="numeric"
              defaultValue={values.capacity}
            />
          )}
        </Field>

        <Field id="event-starts" label="Starts" required error={state.fieldErrors?.startsAt}>
          {(props) => (
            <Input {...props} name="startsAt" type="datetime-local" defaultValue={values.startsAt} />
          )}
        </Field>

        <Field id="event-ends" label="Ends" hint="Optional." error={state.fieldErrors?.endsAt}>
          {(props) => <Input {...props} name="endsAt" type="datetime-local" defaultValue={values.endsAt} />}
        </Field>
      </div>

      <label className="flex items-center gap-2.5 text-sm text-ink">
        <Checkbox name="isAllDay" value="on" defaultChecked={values.isAllDay === 'on'} />
        This is an all-day event
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="event-location"
          label="Where"
          hint="A room, a building, a campus. “Online” belongs in the mode above, not here."
          error={state.fieldErrors?.location}
        >
          {(props) => <Input {...props} name="location" defaultValue={values.location} maxLength={200} />}
        </Field>

        <Field
          id="event-location-url"
          label="Location link"
          hint="Optional. A map pin or a page that describes the place."
          error={state.fieldErrors?.locationUrl}
        >
          {(props) => (
            <Input {...props} name="locationUrl" type="url" inputMode="url" defaultValue={values.locationUrl} placeholder="https://" />
          )}
        </Field>
      </div>

      <Field
        id="event-join-url"
        label="Joining link"
        hint="Required for an online event: a meeting link, or a page that says how to join."
        error={state.fieldErrors?.joinUrl}
      >
        {(props) => (
          <Input {...props} name="joinUrl" type="url" inputMode="url" defaultValue={values.joinUrl} placeholder="https://" />
        )}
      </Field>

      <Field
        id="event-visibility"
        label="Who can see it"
        hint="The database clamps this to your profile’s own visibility. If your profile is private, the event is stored private too — and the page tells you when that happens."
        error={state.fieldErrors?.visibility}
      >
        {(props) => (
          <Select {...props} name="visibility" defaultValue={values.visibility ?? 'public'}>
            {EVENT_VISIBILITIES.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <SubmitButton variant="primary" pendingLabel="Creating…">
        Create the event
      </SubmitButton>
    </form>
  )
}
