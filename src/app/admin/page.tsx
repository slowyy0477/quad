import { Alert } from '@/components/ui/alert'
import { SectionHeading, EmptyState, Surface } from '@/components/ui/surface'
import { AdminPager, readPage } from '@/features/admin/components/admin-pager'
import { ModerationLimits, StaffOnly } from '@/features/admin/components/admin-shell'
import { getStaffRole } from '@/features/admin/queries'
import { ReportDecisionActions } from '@/features/moderation/components/decision-actions'
import { ReportTargetPreview } from '@/features/moderation/components/report-target'
import { ADMIN_PAGE_SIZE, getOpenReports } from '@/features/moderation/queries'
import type { ReportKind } from '@/features/moderation/schemas'
import { getUser } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import Link from 'next/link'

/**
 * The open report queue.
 *
 * Newest first, because a report that arrived four minutes ago is usually about
 * something still happening and one from last Tuesday is not. Oldest-first exists
 * as an argument ("nothing should sit for ever"); newest-first wins because the
 * failure it prevents is a live pile-on, and because the queue shows its own age —
 * every row carries the time it arrived, so a backlog is visible rather than
 * implied.
 *
 * A row shows the reported thing inline. A moderator cannot decide from a reason
 * string alone, and making them open a second tab to see what was reported is how
 * decisions get made from titles.
 *
 * There is no bulk action and no "select all". Every decision here is recorded
 * against a named moderator with a reason; a bulk control turns twenty decisions
 * into one click, and the log would then say twenty people were hidden by one
 * reason that only fitted one of them.
 */

/** What each kind is called in the dialog headings. */
const SUBJECT: Record<ReportKind, string> = {
  post: 'this post',
  comment: 'this comment',
  project: 'this project',
  idea: 'this idea',
  message: 'this message',
  profile: 'this account',
}

const KIND_LABEL: Record<ReportKind, string> = {
  post: 'Post',
  comment: 'Comment',
  project: 'Project',
  idea: 'Idea',
  message: 'Private message',
  profile: 'Profile',
}

const DATE = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
})

function when(iso: string): string {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? 'at an unknown time' : DATE.format(parsed)
}

export default async function AdminQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string | string[] }>
}) {
  const [role, user, params] = await Promise.all([getStaffRole(), getUser(), searchParams])

  if (!role) return <StaffOnly signedIn={Boolean(user)} />

  const page = readPage(params.page)
  const { rows, total, error } = await getOpenReports({ page })

  return (
    <div className="space-y-6">
      <SectionHeading
        level={2}
        title="Reports"
        description={
          total === 0
            ? 'No report is waiting for a decision.'
            : `${total} open ${total === 1 ? 'report' : 'reports'}, newest first.`
        }
      />

      {error ? (
        <Alert tone="danger" title="The queue could not be loaded">
          {error}
        </Alert>
      ) : null}

      {rows && rows.length === 0 ? (
        <EmptyState title="Nothing needs a decision">
          When somebody reports a post, a comment, a project, an idea, a message or a person, it
          appears here with the reported content shown inline. Every action you take from here is
          recorded with your name and your reason.
        </EmptyState>
      ) : null}

      {rows && rows.length > 0 ? (
        <ul className="space-y-4">
          {rows.map((report) => (
            <li key={report.id}>
              <Surface className="p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="highlight">{report.reason}</Badge>
                      <span className="text-xs text-ink-muted">
                        {KIND_LABEL[report.kind]} · reported {when(report.createdAt)} UTC
                      </span>
                    </div>

                    <p className="mt-1.5 text-xs text-ink-muted">
                      Reported by{' '}
                      {report.reporter ? (
                        <Link
                          href={`/u/${report.reporter.username}`}
                          className="rounded text-ink underline underline-offset-2"
                        >
                          {report.reporter.displayName}
                        </Link>
                      ) : (
                        'an account that has since been deleted'
                      )}
                    </p>
                  </div>
                </div>

                {report.detail ? (
                  <p className="mt-3 border-l-2 border-highlight-400/60 pl-3 text-sm whitespace-pre-wrap text-ink-muted">
                    {report.detail}
                  </p>
                ) : null}

                {/* The reported thing itself, as text. See report-target.tsx. */}
                <div className="mt-4 rounded border border-hairline bg-paper-sunken p-3">
                  <ReportTargetPreview target={report.target} />
                </div>

                <div className="mt-4 border-t border-rule pt-4">
                  <ReportDecisionActions
                    reportId={report.id}
                    subject={SUBJECT[report.kind]}
                    reportedName={report.reported?.displayName ?? 'that account'}
                    reason={report.reason}
                    hasContent={report.kind !== 'profile'}
                  />
                </div>

                {report.target.kind === 'profile' ? (
                  <p className="mt-3 text-xs text-ink-faint">
                    This is a report about a person, so there is no content to hide. Warn or suspend
                    the account, or dismiss the report.
                  </p>
                ) : null}
              </Surface>
            </li>
          ))}
        </ul>
      ) : null}

      <AdminPager basePath="/admin" page={page} perPage={ADMIN_PAGE_SIZE} total={total} />

      <ModerationLimits role={role} />
    </div>
  )
}
