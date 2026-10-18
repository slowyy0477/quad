/**
 * Dates on the opportunity board.
 *
 * Two rules are load-bearing here.
 *
 * 1. **One clock.** Every label takes `today` as an argument instead of calling
 *    `new Date()` itself. A page that computes "closes in 3 days" for row one and
 *    "closes today" for row twenty because midnight passed mid-render is a bug that
 *    only appears at an awkward hour, and only for some readers.
 *
 * 2. **The date is a calendar date, not an instant.** `opportunities.deadline` is a
 *    Postgres `date`, so "closes in 3 days" is a statement about calendar days, not
 *    about 72 hours. The audience is in Pakistan, so "today" is today in
 *    Asia/Karachi -- the same day the reader is having -- rather than the UTC day,
 *    which is five hours behind and would call an 11 p.m. deadline "yesterday".
 *
 * Nothing in this file touches the database or the request, which is what lets the row
 * component (a Client Component boundary in principle) render the same text the server
 * computed.
 */

/** The zone the copy assumes. Events state their own zone; deadlines are calendar dates. */
export const PAKISTAN_ZONE = 'Asia/Karachi'

const DAY_MS = 86_400_000

/**
 * Today's calendar date in Pakistan, as `YYYY-MM-DD`.
 *
 * `en-CA` is the locale whose short date format is ISO-8601, which is why it is used
 * rather than assembling the parts by hand.
 */
export function todayInPakistan(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: PAKISTAN_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/** Shift a `YYYY-MM-DD` date by whole days, without touching local time. */
export function addDays(date: string, days: number): string {
  const shifted = new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
  return shifted.toISOString().slice(0, 10)
}

/** Whole calendar days from `from` to `to`. Negative when `to` is in the past. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
}

/**
 * The human sentence for a stored deadline.
 *
 * Nothing here is estimated: a deadline is compared to one date and the difference is
 * a whole number of days. A listing with no deadline says so rather than borrowing the
 * posting date to look urgent.
 */
export function deadlineLabel(deadline: string | null, today: string): string {
  if (!deadline) return 'No closing date'

  const days = daysBetween(today, deadline)

  if (days === 0) return 'Closes today'
  if (days === 1) return 'Closes tomorrow'
  if (days > 1) return `Closes in ${days} days`
  if (days === -1) return 'Closed yesterday'
  return `Closed ${Math.abs(days)} days ago`
}

/** Whether the stored deadline has already passed. `null` never counts as passed. */
export function deadlineHasPassed(deadline: string | null, today: string): boolean {
  if (!deadline) return false
  return daysBetween(today, deadline) < 0
}

/**
 * Whether a listing is closed for applications.
 *
 * Two independent facts can close one: the poster closed or filled it, or its deadline
 * went by. Both are stored, so this is a read of two columns and not a guess. It is
 * also *not* the same as `status = 'closed'` -- a listing whose deadline passed still
 * has `status = 'open'` in the row, because nothing rewrites it, and saying "closed"
 * while the row says "open" is the honest reading of a date that has gone.
 */
export function opportunityIsClosed(
  opportunity: { status: string; deadline: string | null },
  today: string,
): boolean {
  return opportunity.status !== 'open' || deadlineHasPassed(opportunity.deadline, today)
}

/** `7 Nov 2026`, for the meta line beside a deadline. */
export function formatCalendarDate(date: string | null): string | null {
  if (!date) return null
  const parsed = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return date
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parsed)
}

/**
 * `18 Oct 2026` for a stored instant, read in Pakistan.
 *
 * A `timestamptz` sliced to ten characters is the UTC date, which is the previous day for
 * anything posted before 05:00 local. The date the reader should see is theirs.
 */
export function formatInstantInPakistan(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: PAKISTAN_ZONE,
  }).format(parsed)
}
