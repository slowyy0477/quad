'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Surface } from '@/components/ui/surface'
import { reviewApplicationAction } from '@/features/projects/actions'
import { emptyFormState } from '@/lib/form-state'
import type { ProjectApplicationRow } from '@/features/projects/queries'

/**
 * The pending requests, and the two answers to each.
 *
 * Only the project's managers ever receive these rows: the SELECT policy on
 * `project_applications` is the applicant plus whoever can manage the project, so a
 * plain member reading this gets nothing rather than a redacted list.
 *
 * Accepting does not create the membership here. It sets the status, and the
 * `project_applications_after_update` trigger writes the `project_members` row inside
 * the same transaction — so a request that is accepted is a request whose applicant is
 * on the team, with no window in between.
 */
export function ApplicationReview({
  applications,
  slug,
}: {
  applications: ProjectApplicationRow[]
  slug: string
}) {
  const [state, action] = useActionState(reviewApplicationAction, emptyFormState)

  if (applications.length === 0) {
    return (
      <p className="text-sm text-ink-muted">
        No one has asked to join yet. When someone does, their note appears here and accepting it adds
        them to the team.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      {state.status === 'error' && state.message ? (
        <Alert tone="danger" title="That was not recorded">
          {state.message}
        </Alert>
      ) : null}
      {state.status === 'success' && state.message ? <Alert tone="success">{state.message}</Alert> : null}

      <ul className="space-y-3">
        {applications.map((application) => (
          <Surface as="li" key={application.id} className="p-4">
            <div className="flex items-start gap-3">
              <Avatar
                name={application.applicant?.display_name ?? 'Applicant'}
                src={application.applicant?.avatar_url ?? null}
                size="sm"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {application.applicant ? (
                    <Link
                      href={`/u/${application.applicant.username}`}
                      className="text-sm font-medium text-ink underline-offset-2 hover:underline"
                    >
                      {application.applicant.display_name}
                    </Link>
                  ) : (
                    <span className="text-sm font-medium text-ink-muted">A former member</span>
                  )}
                  {application.desired_role ? (
                    <Badge tone="outline">{application.desired_role}</Badge>
                  ) : null}
                </div>

                {application.message ? (
                  <p className="mt-1.5 text-sm whitespace-pre-wrap text-ink-muted">
                    {application.message}
                  </p>
                ) : (
                  <p className="mt-1.5 text-sm text-ink-faint">No note was written.</p>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  {(['accepted', 'rejected'] as const).map((decision) => (
                    <form key={decision} action={action}>
                      <input type="hidden" name="applicationId" value={application.id} />
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="decision" value={decision} />
                      <Button
                        type="submit"
                        size="sm"
                        variant={decision === 'accepted' ? 'primary' : 'secondary'}
                      >
                        {decision === 'accepted' ? 'Accept' : 'Decline'}
                      </Button>
                    </form>
                  ))}
                </div>
              </div>
            </div>
          </Surface>
        ))}
      </ul>
    </div>
  )
}
