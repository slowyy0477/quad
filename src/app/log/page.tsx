import type { Metadata } from 'next'
import Link from 'next/link'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { EmptyState, SectionHeading } from '@/components/ui/surface'
import { getUser } from '@/lib/supabase/server'
import { LOG_LIST_DAYS } from '@/features/learning/constants'
import { getStudyLog } from '@/features/learning/queries'
import { STREAK_WINDOW_DAYS, databaseToday, streakStrip } from '@/features/learning/streak'
import { DailyLogForm } from '@/features/learning/components/daily-log-form'
import { LogEntryList } from '@/features/learning/components/log-entry-list'
import { StreakStrip } from '@/features/learning/components/streak-strip'

export const metadata: Metadata = {
  title: 'Study log',
  description: 'One entry a day, and the streak those entries actually form.',
}

/**
 * /log — the daily study log.
 *
 * The streak is the number `public.current_study_streak()` returned on this render. The
 * strip beside it is the same fourteen days marked from the rows, and the two are held
 * together by a test rather than by hope. If the reader has never logged anything, no
 * streak is shown at all — "0 day streak" is a discouraging way of saying "you have not
 * started", and it is also a claim about fourteen days that were never observed.
 *
 * The day boundary is stated on the page. It is midnight UTC because that is
 * `current_date` in the database's own time zone, and a streak that disagreed with the
 * rows it is computed from would reset at a different midnight than the one the user sees.
 */
export default async function StudyLogPage() {
  const user = await getUser()

  if (!user) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:py-14">
        <h1 className="text-3xl">Study log</h1>
        <p className="mt-2 max-w-prose text-ink-muted">
          One entry a day. The streak is the run of consecutive days you actually wrote one.
        </p>
        <EmptyState
          className="mt-8"
          title="Sign in to keep your own"
          action={
            <Button asChild variant="primary">
              <Link href="/login?next=/log">Sign in</Link>
            </Button>
          }
        >
          Entries belong to an account and are private to it.
        </EmptyState>
      </div>
    )
  }

  const today = databaseToday()
  const log = await getStudyLog({ windowDays: STREAK_WINDOW_DAYS, listDays: LOG_LIST_DAYS })

  if (log.error) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:py-14">
        <h1 className="text-3xl">Study log</h1>
        <Alert className="mt-6" tone="danger" title="Your study log could not be loaded">
          {log.error}
        </Alert>
      </div>
    )
  }

  const started = log.entryCount > 0
  const strip = streakStrip(log.days, today)
  const todaysEntry = log.entries.find((entry) => entry.log_date === today)

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:py-12">
      <header className="border-b border-rule pb-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="text-3xl">Study log</h1>
          <Link href="/goals" className="text-sm text-accent-700 underline-offset-4 hover:underline">
            Goals and terms →
          </Link>
        </div>
        <p className="mt-2 max-w-prose text-sm text-ink-muted">
          One entry a day. The streak is the run of consecutive days you wrote one — two
          entries on the same day still count once.
        </p>
      </header>

      {started ? (
        <section className="mt-6 border-b border-rule pb-6" aria-labelledby="streak-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
            <h2 id="streak-heading" className="text-2xs font-medium uppercase tracking-[0.16em] text-ink-faint">
              Current streak
            </h2>
            <p className="text-2xs tabular-nums text-ink-faint">
              {log.entryCount} {log.entryCount === 1 ? 'day' : 'days'} logged in total
            </p>
          </div>
          <p className="mt-1 font-display text-4xl tabular-nums text-ink">
            {log.streak}
            <span className="ml-2 text-base text-ink-muted">
              {log.streak === 1 ? 'day' : 'days'}
            </span>
          </p>
          <p className="mt-1 text-sm text-ink-muted">
            {log.streak > 0
              ? 'Counted by the database from your entries, every time this page loads.'
              : 'No run is live at the moment. One entry today starts a new one.'}
          </p>
          <StreakStrip className="mt-4" days={strip} />
        </section>
      ) : (
        <EmptyState className="mt-6" title="No entries yet">
          The first entry is the whole beginning. Log today, and a streak exists from
          tomorrow — not before, because there is nothing yet to count.
        </EmptyState>
      )}

      <section className="mt-7" aria-labelledby="entry-heading">
        <SectionHeading
          title={todaysEntry ? 'Today’s entry' : 'Log today'}
          description={`The day is the database's current date (UTC): ${today}. Entries are one per day.`}
        />
        <div className="mt-4">
          <DailyLogForm today={today} existing={todaysEntry} />
        </div>
      </section>

      {log.entries.length > 0 ? (
        <section className="mt-10" aria-labelledby="recent-heading">
          <SectionHeading
            title="Recent entries"
            description={`The last ${LOG_LIST_DAYS} days that have an entry, newest first.`}
          />
          <div className="mt-2">
            <LogEntryList entries={log.entries} />
          </div>
        </section>
      ) : null}

      <p className="mt-10 border-t border-hairline pt-4 text-2xs text-ink-faint">
        The streak counts days in the database&rsquo;s time zone, which is UTC — so it rolls
        over at midnight UTC rather than at your local midnight. The page and the database
        use the same boundary; a streak that reset at a different midnight than the one your
        rows are filed under would be a bug.
      </p>
    </div>
  )
}
