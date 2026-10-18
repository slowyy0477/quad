'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Field } from '@/components/ui/field'
import { Input, Textarea } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import { requestToJoinAction, withdrawApplicationAction } from '@/features/projects/actions'
import { emptyFormState } from '@/lib/form-state'

/**
 * "Ask to join", with an optional note.
 *
 * The applicant is the session, never a field: `project_applications` forces
 * `applicant_id` to `auth.uid()` and the status to `pending`. The note is the only
 * thing that could be forged here, and it is prose.
 *
 * When a request is already live the form becomes a withdraw control instead. Both
 * branches post a real action — a disabled button would be a control that does
 * nothing, which the honesty rules forbid.
 */
export function JoinForm({
  projectId,
  slug,
  hasPendingApplication,
  isSignedIn,
}: {
  projectId: string
  slug: string
  hasPendingApplication: boolean
  isSignedIn: boolean
}) {
  const [joinState, joinAction] = useActionState(requestToJoinAction, emptyFormState)
  const [withdrawState, withdrawAction] = useActionState(withdrawApplicationAction, emptyFormState)

  if (!isSignedIn) {
    return (
      <Alert tone="info" title="Sign in to ask to join">
        A join request is attached to an account, so the project can see who is asking. Sign in and
        this page will offer the request.
      </Alert>
    )
  }

  if (hasPendingApplication || joinState.status === 'success') {
    return (
      <div className="space-y-3">
        <Alert tone="success" title="Your request is with the project">
          {joinState.message ?? 'The project’s owners can see it and will answer here.'}
        </Alert>
        <form action={withdrawAction}>
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="slug" value={slug} />
          {withdrawState.status === 'error' && withdrawState.message ? (
            <p role="alert" className="mb-2 text-xs font-medium text-danger-600">
              {withdrawState.message}
            </p>
          ) : null}
          <SubmitButton variant="ghost" size="sm" pendingLabel="Withdrawing…">
            Withdraw my request
          </SubmitButton>
        </form>
      </div>
    )
  }

  return (
    <form action={joinAction} className="space-y-4">
      {joinState.status === 'error' && joinState.message ? (
        <Alert tone="danger" title="The request was not sent">
          {joinState.message}
        </Alert>
      ) : null}

      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="slug" value={slug} />

      <Field
        id="join-role"
        label="What you would like to do"
        hint="Optional. A role on the team, such as “Frontend”."
        error={joinState.fieldErrors?.desiredRole}
      >
        {(props) => <Input {...props} name="desiredRole" maxLength={80} autoComplete="off" />}
      </Field>

      <Field
        id="join-note"
        label="Note to the owners"
        hint="Optional. Say what you would bring — a short, specific note is answered more often."
        error={joinState.fieldErrors?.message}
      >
        {(props) => <Textarea {...props} name="message" rows={3} maxLength={2000} />}
      </Field>

      <SubmitButton variant="primary" pendingLabel="Sending…">
        Ask to join
      </SubmitButton>
    </form>
  )
}
