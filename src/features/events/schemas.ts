import { z } from 'zod'
import {
  ATTENDANCE_MODE_VALUES,
  EVENT_TYPE_VALUES,
  EVENT_VISIBILITY_VALUES,
  TIME_ZONE_VALUES,
} from '@/features/events/constants'
import { optionalInt, optionalText, requiredText } from '@/lib/form-schemas'

/**
 * Event validation.
 *
 * The bounds mirror the CHECKs in 0013: title 3..160, description <= 10000, location <=
 * 200, capacity 1..100000, plus `events_online_has_url` below. The zone is restricted to
 * the list the form offers, which is a subset of `pg_timezone_names` -- the trigger would
 * reject an unknown zone with SQLSTATE 22023, but a reader should see a field error while
 * the form is still open rather than a sentence about a database.
 *
 * `created_by`, `slug`, `university_id`, `attendee_count`, `interested_count` and
 * `moderation_status` are absent: the insert trigger sets all six.
 */
export const eventCreateSchema = z
  .object({
    title: requiredText(3, 160, 'The title'),
    description: optionalText(10000, 'The description'),
    type: z.enum(EVENT_TYPE_VALUES as [string, ...string[]]),
    attendanceMode: z.enum(ATTENDANCE_MODE_VALUES as [string, ...string[]]),
    visibility: z.enum(EVENT_VISIBILITY_VALUES as [string, ...string[]]),
    timeZone: z.enum(TIME_ZONE_VALUES as [string, ...string[]]),
    startsAt: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'Give the start date and time'),
    endsAt: optionalText(32, 'The end'),
    location: optionalText(200, 'The location'),
    locationUrl: optionalText(500, 'The location link'),
    joinUrl: optionalText(500, 'The joining link'),
    capacity: optionalInt(1, 100000, 'A capacity between 1 and 100,000'),
    isAllDay: z
      .string()
      .optional()
      .transform((value) => value === 'on' || value === 'true'),
  })
  .refine((value) => !value.endsAt || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value.endsAt), {
    message: 'Give the end date and time, or leave it empty',
    path: ['endsAt'],
  })
  // `events_online_has_url`: an online event with nowhere to join is a broken promise.
  .refine((value) => value.attendanceMode !== 'online' || Boolean(value.joinUrl || value.locationUrl), {
    message: 'An online event needs a joining link, or a page that explains how to join',
    path: ['joinUrl'],
  })
  .refine((value) => !value.joinUrl || /^https?:\/\//i.test(value.joinUrl), {
    message: 'Start the address with http:// or https://',
    path: ['joinUrl'],
  })
  .refine((value) => !value.locationUrl || /^https?:\/\//i.test(value.locationUrl), {
    message: 'Start the address with http:// or https://',
    path: ['locationUrl'],
  })

/** An RSVP. `not_going` is not offered: the way to say that is to cancel. */
export const rsvpSchema = z.object({
  status: z.enum(['going', 'interested']),
})

export type EventCreateInput = z.infer<typeof eventCreateSchema>
