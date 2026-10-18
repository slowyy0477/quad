import { scaleLabel } from '@/features/learning/constants'

/**
 * The recent entries, newest first.
 *
 * A definition list rather than cards: the reader is scanning for a pattern across days
 * ("I stopped logging on Fridays"), and a column of boxes hides that pattern behind
 * chrome. The date is the anchor in tabular figures; everything else hangs off it.
 *
 * An entry with no hours and no note is still an entry — it is the fact that the day was
 * logged, which is what the streak counts. It is rendered, not skipped.
 */
export type LogEntry = {
  id: string
  log_date: string
  hours_studied: number | null
  mood: number | null
  productivity: number | null
  summary: string | null
  wins: string | null
  blockers: string | null
}

export function LogEntryList({ entries }: { entries: LogEntry[] }) {
  return (
    <ol className="divide-y divide-hairline">
      {entries.map((entry) => {
        const mood = scaleLabel(entry.mood)
        const productivity = scaleLabel(entry.productivity)
        return (
          <li key={entry.id} className="py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p className="font-display text-base tabular-nums text-ink">{entry.log_date}</p>
              <p className="text-2xs tabular-nums text-ink-faint">
                {entry.hours_studied !== null ? `${entry.hours_studied} h` : 'no hours recorded'}
                {mood ? ` · felt ${mood.toLowerCase()}` : ''}
                {productivity ? ` · output ${productivity.toLowerCase()}` : ''}
              </p>
            </div>

            {entry.summary ? (
              <p className="mt-1 max-w-prose text-sm text-ink">{entry.summary}</p>
            ) : null}

            {entry.wins || entry.blockers ? (
              <dl className="mt-1.5 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                {entry.wins ? (
                  <div className="flex gap-2">
                    <dt className="text-2xs uppercase tracking-[0.14em] text-ink-faint">Went well</dt>
                    <dd className="min-w-0 text-ink-muted">{entry.wins}</dd>
                  </div>
                ) : null}
                {entry.blockers ? (
                  <div className="flex gap-2">
                    <dt className="text-2xs uppercase tracking-[0.14em] text-ink-faint">Got in the way</dt>
                    <dd className="min-w-0 text-ink-muted">{entry.blockers}</dd>
                  </div>
                ) : null}
              </dl>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}
