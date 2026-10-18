/**
 * The study streak, as the interface computes it.
 *
 * ONE RULE, TWO IMPLEMENTATIONS, DELIBERATELY
 * -------------------------------------------
 * The number the page shows comes from `public.current_study_streak()` (0011), read with
 * `supabase.rpc` on every render. Nothing is incremented in the browser and nothing is
 * cached: a streak counter kept in a component would be a claim about the last fourteen
 * days maintained by something that has not read them.
 *
 * The functions here do not replace it. They answer the other question the page needs —
 * *which* of the last fourteen days carry a log — and they exist as pure functions so
 * that the same gap-and-island rule the database uses can be reproduced and asserted in a
 * test, against the very inputs `tests/db/learning.test.ts` feeds the SQL function. The
 * strip and the number therefore cannot disagree about a day boundary: there is only one
 * rule, written twice, and a test holding the two copies together.
 *
 * THE DAY BOUNDARY
 * ----------------
 * The database's boundary is `current_date` in the database's own time zone. Supabase's
 * Postgres runs with `TimeZone = UTC`, so `current_date` rolls over at **midnight UTC**,
 * and that is the midnight this module uses: `databaseToday()` takes the UTC date of the
 * server clock rather than a local one, so the reader's laptop being in Karachi or in
 * Berlin changes nothing about which days count.
 *
 * That matters for two reasons, and both are visible to a reader sitting at their desk at
 * 01:00 local time (05:00 the previous day in UTC+5):
 *
 *   * `current_study_streak()` counts a chain ending *today or yesterday*, because today
 *     is not over — a streak that reset at local midnight while someone slept would be a
 *     bug reported as "it deleted my streak". So a day either side of the rollover keeps
 *     the chain alive either way.
 *   * The four hours between local midnight and UTC midnight are the only window where a
 *     local-date implementation and this one differ, and using the local date there would
 *     fill in a mark the database has not written yet.
 *
 * `daily_logs.log_date` is a plain `date` with one day of tolerance built into the trigger
 * (`log_date <= current_date + 1`), which is the schema's own acknowledgement that a
 * student's "today" and the server's can be a day apart.
 */

/** How many days the strip shows, and therefore how many days are fetched for it. */
export const STREAK_WINDOW_DAYS = 14

/** ISO date (`yyyy-mm-dd`) for an instant using the database's boundary. */
export function databaseToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

/** Shift an ISO date by whole days. UTC arithmetic, so no daylight-saving step in it. */
export function shiftDate(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number)
  const base = Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10)
}

export type StreakDay = {
  /** `yyyy-mm-dd`, the value `daily_logs.log_date` holds. */
  date: string
  /** A row exists for this day. */
  logged: boolean
  isToday: boolean
}

/**
 * The last `days` days ending on `today`, oldest first, marked from the dates supplied.
 *
 * Duplicates are not a thing — `daily_logs_one_per_day` is a unique constraint on
 * `(profile_id, log_date)` — but the set makes that explicit rather than assumed, so two
 * rows for one day could never draw two marks.
 */
export function streakStrip(
  dates: Iterable<string>,
  today: string,
  days: number = STREAK_WINDOW_DAYS,
): StreakDay[] {
  const logged = new Set(dates)
  return Array.from({ length: days }, (_, index) => {
    const date = shiftDate(today, index - (days - 1))
    return { date, logged: logged.has(date), isToday: date === today }
  })
}

/**
 * The chain length a set of log dates implies, by the same gap-and-island rule as
 * `public.current_study_streak()`:
 *
 *   * the anchor is the most recent day at or before today;
 *   * a chain ending before yesterday has lapsed, so the answer is 0;
 *   * the answer is the leading run of consecutive days counting back from the anchor.
 *
 * Used in tests to hold the interface's rule against the database's, and on the log page
 * only to decide which sentence to show next to the number the database returned (log
 * today to keep it going, or pick it up again). The number on screen is never this
 * function's output.
 */
export function streakFromLogDates(dates: Iterable<string>, today: string): number {
  const days = [...new Set(dates)].filter((date) => date <= today).sort().reverse()
  const anchor = days[0]
  if (!anchor || anchor < shiftDate(today, -1)) return 0

  let streak = 0
  for (const [index, date] of days.entries()) {
    if (date !== shiftDate(anchor, -index)) break
    streak += 1
  }
  return streak
}

/** True when the most recent log is yesterday rather than today: the chain is still live. */
export function loggedToday(dates: Iterable<string>, today: string): boolean {
  return new Set(dates).has(today)
}
