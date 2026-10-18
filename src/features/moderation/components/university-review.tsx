'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { Textarea } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import { reviewUniversityAction } from '@/features/moderation/actions'
import { emptyUniversityReviewState } from '@/features/moderation/form-state'

/**
 * Approving or rejecting a university request.
 *
 * The same shape as a report decision and for the same reasons: the object is
 * named in the title, the reason is required by the database, and both outcomes
 * are recorded in the log — including a rejection, which is the one a future
 * moderator will need to understand ("we were asked about this before and said
 * no, because…").
 *
 * `universities.status` is behind app.reject_protected_column_change (0003), so
 * neither of these is an UPDATE: both call public.review_university_request,
 * which is the only thing that may write those columns.
 */
export function UniversityReviewActions({
  universityId,
  name,
}: {
  universityId: string
  name: string
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <ReviewDialog universityId={universityId} name={name} decision="approve" />
      <ReviewDialog universityId={universityId} name={name} decision="reject" />
    </div>
  )
}

function ReviewDialog({
  universityId,
  name,
  decision,
}: {
  universityId: string
  name: string
  decision: 'approve' | 'reject'
}) {
  const [state, send] = useActionState(reviewUniversityAction, emptyUniversityReviewState)

  // A success replaces the form with a confirmation instead of closing the dialog.
  // Same reasoning as the report decisions in decision-actions.tsx: an explicit
  // "recorded" for an irreversible decision, and no effect calling setState.
  const done = state.status === 'success'
  const approving = decision === 'approve'

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant={approving ? 'primary' : 'danger'} size="sm">
          {approving ? 'Approve' : 'Reject'}
        </Button>
      </DialogTrigger>

      <DialogContent
        title={approving ? `Approve ${name}?` : `Reject ${name}?`}
        description={
          approving
            ? 'It becomes publicly listed and students can choose it as their university. The decision goes in the audit log.'
            : 'The request is closed and the institution is not listed. The decision goes in the audit log, which is where a future moderator will look.'
        }
      >
        {done ? (
          <div className="space-y-4">
            <Alert tone="success" title="Recorded">
              {state.message}
            </Alert>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="secondary">Close</Button>
              </DialogClose>
            </DialogFooter>
          </div>
        ) : (
          <form action={send} className="space-y-5">
            {state.status === 'error' ? <Alert tone="danger">{state.message}</Alert> : null}

            <input type="hidden" name="universityId" value={universityId} />
            <input type="hidden" name="decision" value={decision} />

            <Field
              id={`reason-${universityId}-${decision}`}
              label="Reason"
              hint="Kept in the audit log. For a rejection, say what the applicant should change if they ask again."
              error={state.fieldErrors?.reason}
              required
            >
              {(fieldProps) => (
                <Textarea
                  {...fieldProps}
                  name="reason"
                  rows={3}
                  maxLength={1000}
                  placeholder={
                    approving
                      ? 'Checked against the institution’s own listing on…'
                      : 'Not an accredited institution, or a duplicate of…'
                  }
                />
              )}
            </Field>

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="secondary">
                  Cancel
                </Button>
              </DialogClose>
              <SubmitButton variant={approving ? 'primary' : 'danger'} pendingLabel="Recording…">
                {approving ? 'Approve' : 'Reject'}
              </SubmitButton>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
