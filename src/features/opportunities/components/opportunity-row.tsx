import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Surface } from '@/components/ui/surface'
import { deadlineLabel, formatCalendarDate, opportunityIsClosed } from '@/features/opportunities/board'
import { opportunityTypeLabel, workModeLabel } from '@/features/opportunities/constants'
import type { OpportunityBoardRow } from '@/features/opportunities/queries'

/**
 * One listing on the board.
 *
 * Every fact is a stored column: the deadline is `deadline`, the saved count is
 * `save_count` (a trigger over `opportunity_saves`), the type and work mode are CHECK-
 * constrained values. Nothing here is estimated, and nothing is rounded to look busier.
 *
 * Open and closed are distinguished twice -- the badge says which, and the deadline line
 * says it again in words ("Closed 3 days ago") -- because a colour is not a distinction
 * for every reader, and never in a forced-colours mode.
 */
export function OpportunityRow({
  opportunity,
  today,
}: {
  opportunity: OpportunityBoardRow
  /** One clock for the whole page, passed in rather than read per row. */
  today: string
}) {
  const closed = opportunityIsClosed(opportunity, today)
  const closedByDate = opportunity.status === 'open' && closed

  return (
    <Surface as="article" className="p-4 transition-colors hover:border-rule">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base leading-snug">
            <Link
              href={`/opportunities/${opportunity.slug}`}
              className="text-ink underline-offset-2 hover:underline"
            >
              {opportunity.title}
            </Link>
          </h3>
          <p className="mt-1 text-sm text-ink-muted">{opportunity.organisation}</p>
        </div>

        <Badge tone={closed ? 'neutral' : 'success'}>
          {closedByDate ? 'Closed' : opportunity.status === 'open' ? 'Open' : opportunity.status === 'filled' ? 'Filled' : 'Closed'}
        </Badge>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Badge tone="neutral">{opportunityTypeLabel(opportunity.type)}</Badge>
        <Badge tone="outline">{workModeLabel(opportunity.work_mode)}</Badge>
        {opportunity.location ? <Badge tone="outline">{opportunity.location}</Badge> : null}
        {opportunity.compensation ? <Badge tone="outline">{opportunity.compensation}</Badge> : null}
        {opportunity.saved ? <Badge tone="accent">Saved</Badge> : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-3 text-xs">
        <p className={closed ? 'text-ink-muted' : 'font-medium text-ink'}>
          {deadlineLabel(opportunity.deadline, today)}
          {opportunity.deadline ? (
            <span className="ml-2 font-normal text-ink-faint tabular">
              {formatCalendarDate(opportunity.deadline)}
            </span>
          ) : null}
        </p>

        <p className="text-ink-faint">
          <span className="tabular">{opportunity.save_count}</span>{' '}
          {opportunity.save_count === 1 ? 'person saved this' : 'people saved this'}
        </p>
      </div>
    </Surface>
  )
}
