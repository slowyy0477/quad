import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { EmptyState, Surface } from '@/components/ui/surface'
import { BugTriageForm } from '@/features/bugs/components/bug-triage-form'
import type { BugReportRow } from '@/features/bugs/queries'
import { BUG_STATUS_LABEL, type BugStatus } from '@/features/bugs/schemas'

/**
 * A list of bug reports, rendered the same way for the reader and the maintainer.
 *
 * One component for both, with the maintainer-only parts behind a flag, because
 * the two lists differ by exactly two things — whether the reporter is named and
 * whether there is a triage control — and two components would drift until the
 * reader's list stopped showing what the maintainer sees.
 *
 * The body is rendered as text, never as HTML: a bug report is a stranger's
 * input and this page is the one place the maintainer reads it.
 */

const DATE = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
})

function when(iso: string): string {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? 'an unknown time' : `${DATE.format(parsed)} UTC`
}

const TONE: Record<BugStatus, 'neutral' | 'highlight' | 'success'> = {
  open: 'highlight',
  reviewed: 'neutral',
  fixed: 'success',
  closed: 'neutral',
}

export function BugReportList({
  reports,
  emptyMessage,
  showReporter = false,
  showTriage = false,
}: {
  reports: BugReportRow[]
  /** What to say when there are none, per surface. */
  emptyMessage: string
  showReporter?: boolean
  /** The status control. Administrator-only list only. */
  showTriage?: boolean
}) {
  if (reports.length === 0) {
    return <EmptyState title="Nothing here yet">{emptyMessage}</EmptyState>
  }

  return (
    <ul className="space-y-3">
      {reports.map((report) => (
        <li key={report.id}>
          <Surface className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <h3 className="text-sm font-medium text-ink">{report.title}</h3>
              <Badge tone={TONE[report.status]}>{BUG_STATUS_LABEL[report.status]}</Badge>
            </div>

            <p className="mt-1 text-xs text-ink-muted">
              {showReporter && report.reporter ? (
                <>
                  <Link
                    href={`/u/${report.reporter.username}`}
                    className="rounded text-accent-700 underline underline-offset-2"
                  >
                    {report.reporter.displayName}
                  </Link>
                  {' · '}
                </>
              ) : null}
              Reported {when(report.createdAt)}
            </p>

            <p className="mt-3 text-sm whitespace-pre-wrap text-ink">{report.body}</p>

            {report.pageUrl ? (
              <p className="mt-2 text-xs text-ink-faint">
                On: <span className="break-all">{report.pageUrl}</span>
              </p>
            ) : (
              <p className="mt-2 text-xs text-ink-faint">No page was recorded.</p>
            )}

            {showTriage ? (
              <div className="mt-4 border-t border-rule pt-3">
                <BugTriageForm bugId={report.id} status={report.status} />
              </div>
            ) : null}
          </Surface>
        </li>
      ))}
    </ul>
  )
}
