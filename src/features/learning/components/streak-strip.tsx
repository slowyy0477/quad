import { cn } from '@/lib/utils'

/**
 * The last fourteen days, as marks.
 *
 * Two shapes on purpose: a logged day is a tall bar, an unlogged day is a short rule. The
 * strip is a *record of which days exist*, so its job is to be scanned rather than read —
 * fourteen columns of text would be a table, and a table is not what a habit looks like.
 *
 * Today is outlined rather than filled differently: a filled "today" would be
 * indistinguishable from a logged today, and those are two different facts.
 *
 * The bars are decorative to a screen reader; the caption carries the same information as
 * a sentence, and `role="img"` with that sentence as its label is what a group of
 * decorative marks needs to be.
 */
export function StreakStrip({
  days,
  className,
}: {
  days: { date: string; logged: boolean; isToday: boolean }[]
  className?: string
}) {
  if (days.length === 0) return null

  const logged = days.filter((day) => day.logged).length
  const summary = `${logged} of the last ${days.length} days have an entry.`

  return (
    <div className={className}>
      <div role="img" aria-label={summary} className="flex h-8 items-end gap-1">
        {days.map((day) => (
          <span
            key={day.date}
            className={cn(
              'flex-1 rounded-[2px]',
              day.logged ? 'h-8 bg-accent-600' : 'h-1.5 bg-rule',
              day.isToday && 'outline outline-1 outline-offset-2 outline-ink-faint',
            )}
          />
        ))}
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-3 text-2xs text-ink-faint">
        <span className="tabular-nums">{summary}</span>
        <span>{days[0]?.date} — today</span>
      </div>
    </div>
  )
}
