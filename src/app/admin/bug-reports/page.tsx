import Link from 'next/link'
import { Alert } from '@/components/ui/alert'
import { EmptyState, SectionHeading } from '@/components/ui/surface'
import { AdminPager, readPage } from '@/features/admin/components/admin-pager'
import { StaffOnly } from '@/features/admin/components/admin-shell'
import { getAdminRole, getStaffRole } from '@/features/admin/queries'
import { BugReportList } from '@/features/bugs/components/bug-report-list'
import { BUGS_PAGE_SIZE, getBugReports } from '@/features/bugs/queries'
import { BUG_STATUSES, BUG_STATUS_LABEL, type BugStatus } from '@/features/bugs/schemas'
import { cn } from '@/lib/utils'
import { getUser } from '@/lib/supabase/server'

/**
 * Bug reports, for the maintainer.
 *
 * Administrator-only, and the page says why rather than pretending the URL does
 * not exist: a moderator who follows a link from the navigation of a screenshot
 * should be told they cannot read this, not left wondering whether it is broken.
 * The refusal is also enforced twice — `bug_reports_select_admin` returns nothing
 * to a moderator, and `grant update (status)` means the triage control could not
 * write even if it were rendered.
 *
 * The triage control is a select and a save button rather than a dialog, because
 * unlike hiding somebody's post it is neither destructive nor irreversible. A
 * confirmation on every status change trains the reader to click through
 * confirmations, and that habit is what makes the moderation dialogs worthless.
 */
export const metadata = { title: 'Bug reports', robots: { index: false, follow: false } }

const FILTERS: { value: BugStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'Every report' },
  ...BUG_STATUSES.map((status) => ({ value: status as BugStatus | 'all', label: BUG_STATUS_LABEL[status] })),
]

function readStatus(value: string | string[] | undefined): BugStatus | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw) return undefined
  return (BUG_STATUSES as readonly string[]).includes(raw) ? (raw as BugStatus) : undefined
}

export default async function AdminBugReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string | string[]; status?: string | string[] }>
}) {
  const [role, admin, user, params] = await Promise.all([
    getStaffRole(),
    getAdminRole(),
    getUser(),
    searchParams,
  ])

  if (!role) return <StaffOnly signedIn={Boolean(user)} />

  if (!admin) {
    return (
      <div className="space-y-6">
        <SectionHeading level={2} title="Bug reports" description="Administrators only." />

        <Alert tone="warning" title="Your account cannot read this">
          Bug reports are readable by the person who wrote them and by an administrator. This is not
          a display decision: <code>bug_reports_select_admin</code> returns no rows for a moderator
          account, and the status column is not in any grant that a moderator holds. Rendering the
          page for you would show an empty list that looked like a bug in the list.
        </Alert>
      </div>
    )
  }

  const page = readPage(params.page)
  const status = readStatus(params.status)
  const { rows, total, error } = await getBugReports({ status, page })

  return (
    <div className="space-y-6">
      <SectionHeading
        level={2}
        title="Bug reports"
        description={
          total === 0
            ? 'No bug report matches this filter.'
            : `${total} ${total === 1 ? 'report' : 'reports'}, newest first.`
        }
      />

      <nav aria-label="Filter by status" className="border-b border-rule">
        <ul className="flex flex-wrap gap-x-1">
          {FILTERS.map((filter) => {
            const active = (status ?? 'all') === filter.value
            const href =
              filter.value === 'all' ? '/admin/bug-reports' : `/admin/bug-reports?status=${filter.value}`

            return (
              <li key={filter.value}>
                <Link
                  href={href}
                  aria-current={active ? 'true' : undefined}
                  className={cn(
                    '-mb-px inline-flex min-h-11 items-center border-b-2 px-3 text-sm',
                    active
                      ? 'border-accent-600 font-medium text-ink'
                      : 'border-transparent text-ink-muted hover:text-ink',
                  )}
                >
                  {filter.label}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>

      {error ? (
        <Alert tone="danger" title="The reports could not be loaded">
          {error}
        </Alert>
      ) : null}

      {rows && rows.length === 0 ? (
        <EmptyState title="Nothing here">
          Bug reports arrive from the form at <Link href="/report-a-bug">/report-a-bug</Link>, from
          anybody with an account. They are listed newest first, and the status you set here is what
          the reporter sees.
        </EmptyState>
      ) : null}

      {rows && rows.length > 0 ? (
        <BugReportList reports={rows} emptyMessage="" showReporter showTriage />
      ) : null}

      <AdminPager
        basePath="/admin/bug-reports"
        page={page}
        perPage={BUGS_PAGE_SIZE}
        total={total}
        params={{ status }}
      />
    </div>
  )
}
