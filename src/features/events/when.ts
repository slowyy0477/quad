/**
 * When an event happens, said in the organiser's own zone.
 *
 * `starts_at` is a `timestamptz` -- a real instant -- and `time_zone` is the IANA zone the
 * organiser was thinking in when they wrote "14:00". Both are stored, so the page can say
 * *when* and *where the clock is*, rather than printing a bare time and leaving the reader
 * to guess whether it means their afternoon or someone else's.
 *
 * The audience is in Pakistan. Every surface that shows an event time names the zone
 * explicitly: `(Asia/Karachi)`, not an abbreviation, because "PKT" is not recognisable to
 * a first-year and "GMT+5" is a different string every six months.
 */

/** The zone the copy assumes when an event has not said otherwise. */
export const PAKISTAN_ZONE = 'Asia/Karachi'

/** A zone Intl will accept, or UTC. `events.time_zone` is validated on write; this is a belt. */
export function safeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return PAKISTAN_ZONE
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone }).format(new Date(0))
    return timeZone
  } catch {
    return 'UTC'
  }
}

const dayFormatOptions: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
}

function dayIn(zone: string, instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', { ...dayFormatOptions, timeZone: zone }).formatToParts(
    instant,
  )
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''

  // Assembled rather than formatted whole: `en-GB` puts a comma after the weekday
  // ("Sat, 7 Nov 2026"), and this interface writes dates without one everywhere else.
  return `${pick('weekday')} ${pick('day')} ${pick('month')} ${pick('year')}`.trim()
}

function timeIn(zone: string, instant: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant)
}

/**
 * One sentence for when an event is on.
 *
 *   Sat 7 Nov 2026 · 14:30–16:00 (Asia/Karachi)
 *   Sat 7 Nov 2026 · all day
 *   Sat 7 Nov 2026 14:30 – Sun 8 Nov 2026 12:00 (Asia/Karachi)
 *
 * The zone is printed for timed events and omitted for all-day ones, which have no clock
 * to be wrong about.
 */
export function formatEventWhen({
  startsAt,
  endsAt,
  timeZone,
  isAllDay,
}: {
  startsAt: string
  endsAt: string | null
  timeZone: string
  isAllDay: boolean
}): string {
  const zone = safeZone(timeZone)
  const start = new Date(startsAt)
  if (Number.isNaN(start.getTime())) return 'Date to be confirmed'

  const end = endsAt ? new Date(endsAt) : null
  const validEnd = end && !Number.isNaN(end.getTime()) ? end : null
  const startDay = dayIn(zone, start)

  if (isAllDay) {
    if (!validEnd || dayIn(zone, validEnd) === startDay) return `${startDay} · all day`
    return `${startDay} – ${dayIn(zone, validEnd)} · all day`
  }

  if (!validEnd) return `${startDay} · ${timeIn(zone, start)} (${zone})`
  if (dayIn(zone, validEnd) === startDay) {
    return `${startDay} · ${timeIn(zone, start)}–${timeIn(zone, validEnd)} (${zone})`
  }

  return `${startDay} ${timeIn(zone, start)} – ${dayIn(zone, validEnd)} ${timeIn(zone, validEnd)} (${zone})`
}

/** Just the day, for a list row. */
export function formatEventDay(startsAt: string, timeZone: string): string {
  const zone = safeZone(timeZone)
  const start = new Date(startsAt)
  if (Number.isNaN(start.getTime())) return 'Date to be confirmed'
  return dayIn(zone, start)
}

/** Just the start time, with the zone named. */
export function formatEventTime(startsAt: string, timeZone: string): string {
  const zone = safeZone(timeZone)
  const start = new Date(startsAt)
  if (Number.isNaN(start.getTime())) return ''
  return `${timeIn(zone, start)} (${zone})`
}

/**
 * The offset a zone is at, in milliseconds, at a given instant.
 *
 * The standard trick: format the instant *as if* it were UTC in that zone, and subtract.
 * `Intl` carries the zone database, so this is as accurate as the platform's copy of it,
 * including daylight saving.
 */
function zoneOffsetMs(instant: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant))

  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0')

  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  )

  return asUtc - instant
}

/**
 * `2026-11-07T14:30` in `Asia/Karachi` becomes the instant that is 14:30 there.
 *
 * A `datetime-local` input posts a wall-clock time with no zone, which is exactly what the
 * organiser meant but not something Postgres can store in a `timestamptz`. This converts
 * it with the zone's real offset -- iterating, because the offset depends on the instant
 * and the instant depends on the offset -- so a 09:00 workshop in London in July is 08:00Z
 * and in January is 09:00Z.
 *
 * Returns null for anything that is not a wall-clock date and time, which the caller turns
 * into a field error rather than storing a wrong hour.
 */
export function zonedToUtc(local: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim())
  if (!match) return null

  const [, year, month, day, hour, minute, second] = match
  const asUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? '0'),
  )

  if (Number.isNaN(asUtc)) return null

  const zone = safeZone(timeZone)
  let guess = asUtc

  // Two passes settle it; the third is there because a DST boundary can need one more.
  for (let pass = 0; pass < 3; pass += 1) {
    const next = asUtc - zoneOffsetMs(guess, zone)
    if (next === guess) break
    guess = next
  }

  return new Date(guess)
}

/** Whether an event's start has passed, against the same clock the page renders with. */
export function eventHasPassed(startsAt: string, now: Date): boolean {
  const start = new Date(startsAt).getTime()
  if (Number.isNaN(start)) return false
  return start < now.getTime()
}
