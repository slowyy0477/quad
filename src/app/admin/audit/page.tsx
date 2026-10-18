import Link from 'next/link'
import { Alert } from '@/components/ui/alert'
import { EmptyState, SectionHeading, Surface } from '@/components/ui/surface'
import { AdminPager, readPage } from '@/features/admin/components/admin-pager'
import { StaffOnly } from '@/features/admin/components/admin-shell'
import { getStaffRole } from '@/features/admin/queries'
import { ADMIN_PAGE_SIZE, getModerationActions } from '@/features/moderation/queries'
import { getUser } from '@/lib/supabase/server'

/**
 * The audit log.
 *
 * Every decision, with who made it, why, and when. Readable only by moderators
 * (`moderation_actions_select_moderator`), writable by nobody: there is no
 * INSERT, UPDATE or DELETE policy, no grant for any of the three, and a trigger
 * that refuses an UPDATE or DELETE even if a grant appears by mistake. Rows arrive
 * only from the SECURITY DEFINER functions that record them, which is what makes
 * the log evidence rather than another table.
 *
 * A correction is therefore not an edit. It is a second row, `supersedes_id`
 * pointing at the first, and both remain. A log you can edit is not a log — it is a
 * page of opinions with timestamps, and the first person who needs to know what
 * happened last month will be reading somebody's revision of it.
 *
 * The log records *that* an action applied to a post, not the post. Copying hidden
 * content into an append-only table would make "removed" a lie, and would put the
 * worst content in the product into the one table nobody can clean up.
 */

/** The verbs, as sentences about a person. */
const ACTION_COPY: Record<string, string> = {
  hide_content: 'Hid',
  remove_content: 'Removed',
  restore_content: 'Restored',
  warn_user: 'Warned',
  suspend_user: 'Suspended',
  dismiss_report: 'Dismissed a report about',
  approve_university: 'Approved the request for',
  reject_university: 'Rejected the request for',
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

export const metadata = { title: 'Audit log' }

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string | string[] }>
}) {
  const [role, user, params] = await Promise.all([getStaffRole(), getUser(), searchParams])

  if (!role) return <StaffOnly signedIn={Boolean(user)} />

  const page = readPage(params.page)
  const { rows, total, error } = await getModerationActions({ page })

  return (
    <div className="space-y-6">
      <SectionHeading
        level={2}
        title="Audit log"
        description={
          total === 0
            ? 'No moderation action has been recorded yet.'
            : `Every recorded decision, newest first. ${total} in total.`
        }
      />

      <Alert tone="info" title="Records cannot be edited or deleted">
        Not by you, not by an administrator, not through the interface or the API. A decision that
        was wrong is corrected by recording a second one that supersedes it, and the first stays.
        This is why every action asks for a reason before it will go through.
      </Alert>

      {error ? (
        <Alert tone="danger" title="The log could not be loaded">
          {error}
        </Alert>
      ) : null}

      {rows && rows.length === 0 ? (
        <EmptyState title="Nothing has been decided yet">
          The first decision anybody makes in this interface appears here, with their name, the
          reason they gave and the moment they made it.
        </EmptyState>
      ) : null}

      {rows && rows.length > 0 ? (
        <ul className="divide-y divide-hairline">
          {rows.map((row) => (
            <li key={row.id} className="py-4">
              <Surface className="p-4">
                <p className="text-sm text-ink">
                  <span className="font-medium">
                    {row.actor ? (
                      <Link
                        href={`/u/${row.actor.username}`}
                        className="rounded underline underline-offset-2"
                      >
                        {row.actor.displayName}
                      </Link>
                    ) : (
                      'A deleted account'
                    )}
                  </span>{' '}
                  {ACTION_COPY[row.action] ?? row.action}{' '}
                  {row.target ? (
                    <Link
                      href={`/u/${row.target.username}`}
                      className="rounded underline underline-offset-2"
                    >
                      {row.target.displayName}
                    </Link>
                  ) : row.university ? (
                    <span>{row.university}</span>
                  ) : (
                    'a deleted account'
                  )}
                  {row.subject ? <span className="text-ink-muted"> — {row.subject}</span> : null}
                </p>

                <p className="mt-2 border-l-2 border-rule pl-3 text-sm whitespace-pre-wrap text-ink-muted">
                  {row.reason}
                </p>

                <p className="mt-2 text-xs text-ink-faint">
                  {when(row.createdAt)} UTC
                  {row.supersedesId ? ' · supersedes an earlier decision' : ''}
                </p>
              </Surface>
            </li>
          ))}
        </ul>
      ) : null}

      <AdminPager
        basePath="/admin/audit"
        page={page}
        perPage={ADMIN_PAGE_SIZE}
        total={total}
      />
    </div>
  )
}
