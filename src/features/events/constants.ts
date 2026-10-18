/**
 * The event vocabulary.
 *
 * Each list mirrors a CHECK in 0013_opportunities_events.sql. If they drift the database
 * refuses the write -- the right failure, but a confusing one -- so the constraint is
 * quoted next to the list.
 */

/** `events.type` CHECK, all nine values. */
export const EVENT_TYPES = [
  { value: 'workshop', label: 'Workshop' },
  { value: 'hackathon', label: 'Hackathon' },
  { value: 'meetup', label: 'Meetup' },
  { value: 'talk', label: 'Talk' },
  { value: 'competition', label: 'Competition' },
  { value: 'study_group', label: 'Study group' },
  { value: 'deadline', label: 'Deadline' },
  { value: 'social', label: 'Social' },
  { value: 'other', label: 'Other' },
] as const

export const EVENT_TYPE_VALUES = EVENT_TYPES.map((entry) => entry.value)

export function eventTypeLabel(value: string) {
  return EVENT_TYPES.find((entry) => entry.value === value)?.label ?? value
}

/** `events.attendance_mode` CHECK. */
export const ATTENDANCE_MODES = [
  { value: 'onsite', label: 'On site' },
  { value: 'online', label: 'Online' },
  { value: 'hybrid', label: 'Hybrid' },
] as const

export const ATTENDANCE_MODE_VALUES = ATTENDANCE_MODES.map((entry) => entry.value)

export function attendanceModeLabel(value: string) {
  return ATTENDANCE_MODES.find((entry) => entry.value === value)?.label ?? value
}

/**
 * `events.status` CHECK. `completed` is not something anyone sets by hand in this
 * interface; it is a fact the organiser may record, and the list derives "past" from
 * `starts_at` instead.
 */
export const EVENT_STATUSES = [
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'completed', label: 'Completed' },
] as const

export function eventStatusLabel(value: string) {
  return EVENT_STATUSES.find((entry) => entry.value === value)?.label ?? value
}

/**
 * The two visibilities the form offers.
 *
 * The schema also permits `connections` and `private`, and the trigger clamps whatever is
 * chosen down to the creator's profile visibility. Offering all four here would invite
 * choices the trigger silently narrows, so the form offers the two that mean something on
 * a calendar, and the page explains the clamp when it happens.
 */
export const EVENT_VISIBILITIES = [
  { value: 'public', label: 'Anyone on Quad' },
  { value: 'university', label: 'People at my university' },
] as const

export const EVENT_VISIBILITY_VALUES = EVENT_VISIBILITIES.map((entry) => entry.value)

/** `event_attendees.status` CHECK. `going` consumes a place; `interested` does not. */
export const RSVP_STATUSES = [
  { value: 'going', label: 'Going' },
  { value: 'interested', label: 'Interested' },
  { value: 'not_going', label: 'Not going' },
] as const

export function rsvpLabel(value: string) {
  return RSVP_STATUSES.find((entry) => entry.value === value)?.label ?? value
}

/**
 * The zones the form offers, in the order it offers them.
 *
 * A fixed short list rather than all ~600 IANA names: the audience is Pakistani
 * universities, and a select with six hundred entries is a worse control than a text field
 * with six. `events_before_write` validates whatever arrives against `pg_timezone_names`,
 * so this list is a convenience, not the rule.
 */
export const TIME_ZONE_OPTIONS = [
  { value: 'Asia/Karachi', label: 'Asia/Karachi (Pakistan)' },
  { value: 'Asia/Dubai', label: 'Asia/Dubai (Gulf)' },
  { value: 'Asia/Kolkata', label: 'Asia/Kolkata (India)' },
  { value: 'Asia/Dhaka', label: 'Asia/Dhaka (Bangladesh)' },
  { value: 'Europe/London', label: 'Europe/London (UK)' },
  { value: 'America/New_York', label: 'America/New_York (US Eastern)' },
  { value: 'UTC', label: 'UTC' },
] as const

export const TIME_ZONE_VALUES = TIME_ZONE_OPTIONS.map((entry) => entry.value)
