import { Alert } from '@/components/ui/alert'
import { EmptyState, SectionHeading, Surface } from '@/components/ui/surface'
import { AdminPager, readPage } from '@/features/admin/components/admin-pager'
import { StaffOnly } from '@/features/admin/components/admin-shell'
import { getStaffRole } from '@/features/admin/queries'
import { UniversityReviewActions } from '@/features/moderation/components/university-review'
import { ADMIN_PAGE_SIZE, getPendingUniversities } from '@/features/moderation/queries'
import { getUser } from '@/lib/supabase/server'
import Link from 'next/link'

/**
 * University requests waiting for a decision.
 *
 * Oldest first, which is the opposite of the report queue and deliberate: a
 * report is about something happening now, while a request is a person waiting to
 * be able to use the site at all. First in, first decided.
 *
 * Approving and rejecting both go through `public.review_university_request`
 * rather than an UPDATE. `universities.status` is one of the protected columns
 * (app.reject_protected_column_change, 0003), so an UPDATE from `authenticated`
 * is refused no matter what policy exists — which is the right shape: the status
 * of a university is not a field, it is a decision, and the decision is what gets
 * logged.
 */
export const metadata = { title: 'University requests' }

const DATE = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
})

function when(iso: string): string {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? 'at an unknown time' : DATE.format(parsed)
}

export default async function AdminUniversitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string | string[] }>
}) {
  const [role, user, params] = await Promise.all([getStaffRole(), getUser(), searchParams])

  if (!role) return <StaffOnly signedIn={Boolean(user)} />

  const page = readPage(params.page)
  const { rows, total, error } = await getPendingUniversities({ page })

  return (
    <div className="space-y-6">
      <SectionHeading
        level={2}
        title="University requests"
        description={
          total === 0
            ? 'No request is waiting for a decision.'
            : `${total} ${total === 1 ? 'request' : 'requests'} waiting, oldest first.`
        }
      />

      {error ? (
        <Alert tone="danger" title="The requests could not be loaded">
          {error}
        </Alert>
      ) : null}

      {rows && rows.length === 0 ? (
        <EmptyState title="Nothing is waiting">
          Somebody at an institution that is not in the directory has asked for it to be added. When
          one arrives it appears here, oldest first, with what they told us about the institution.
        </EmptyState>
      ) : null}

      {rows && rows.length > 0 ? (
        <ul className="space-y-4">
          {rows.map((request) => (
            <li key={request.id}>
              <Surface className="p-4 sm:p-5">
                <h3 className="font-display text-lg text-ink">{request.name}</h3>

                <p className="mt-1 text-xs text-ink-muted">
                  {[request.city, request.country].filter(Boolean).join(', ') || 'No location given'}
                  {' · asked '}
                  {when(request.createdAt)} UTC
                  {request.submittedBy ? (
                    <>
                      {' by '}
                      <Link
                        href={`/u/${request.submittedBy.username}`}
                        className="rounded text-ink underline underline-offset-2"
                      >
                        {request.submittedBy.displayName}
                      </Link>
                    </>
                  ) : null}
                </p>

                {request.website ? (
                  <p className="mt-2 text-sm">
                    <span className="text-ink-muted">Website: </span>
                    <span className="break-all text-ink">{request.website}</span>
                  </p>
                ) : (
                  <p className="mt-2 text-sm text-ink-faint">No website was given.</p>
                )}

                <div className="mt-4 border-t border-rule pt-4">
                  <UniversityReviewActions universityId={request.id} name={request.name} />
                </div>
              </Surface>
            </li>
          ))}
        </ul>
      ) : null}

      <AdminPager
        basePath="/admin/universities"
        page={page}
        perPage={ADMIN_PAGE_SIZE}
        total={total}
      />

      <Alert tone="info" title="What approving does">
        The institution becomes publicly listed and students can select it as their own. Nothing else
        changes: existing accounts keep the university they already had. A rejection closes the
        request, and the reason is what a future moderator will read when the same institution is
        asked about again.
      </Alert>
    </div>
  )
}
