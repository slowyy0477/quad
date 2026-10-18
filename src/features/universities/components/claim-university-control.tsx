'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SubmitButton } from '@/components/ui/submit-button'
import { claimUniversityAction, leaveUniversityAction } from '@/features/universities/actions'
import { emptyFormState } from '@/lib/form-state'

/**
 * "I study here", and its reverse.
 *
 * Both directions are real server actions with a real statement behind them, so
 * the control is never a dead end: if the database refuses the move, the sentence
 * explaining why is rendered next to the button that caused it rather than at the
 * top of the page.
 *
 * A signed-out visitor gets a sign-in link instead of a button. The claim writes
 * to `profiles.university_id`, and there is no profile to write to until there is
 * a session — offering the button anyway would be a control that cannot work.
 */
export function ClaimUniversityControl({
  universityId,
  universityName,
  isMine,
  signedIn,
  allowLeave = false,
}: {
  universityId: string
  universityName: string
  isMine: boolean
  signedIn: boolean
  /**
   * Whether this instance offers the reverse. The page shows the reader's own
   * institution twice — once in the summary at the top, once in the list — and two
   * identical "Leave" buttons on one page are two ambiguous controls for anyone
   * reading it with a screen reader. Only the summary carries the form.
   */
  allowLeave?: boolean
}) {
  const [claimState, claim] = useActionState(claimUniversityAction, emptyFormState)
  const [leaveState, leave] = useActionState(leaveUniversityAction, emptyFormState)

  if (!signedIn) {
    return (
      <Button asChild variant="secondary" size="sm">
        <Link href="/login?next=/universities">Sign in to say you study here</Link>
      </Button>
    )
  }

  if (isMine) {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="success">You study here</Badge>
          {allowLeave ? (
            <form action={leave}>
              {/* The name is sent so the confirmation on the way back can name the
                  institution. It does not decide what is written. */}
              <input type="hidden" name="name" value={universityName} />
              <SubmitButton variant="ghost" size="sm" pendingLabel="Leaving…">
                Leave
              </SubmitButton>
            </form>
          ) : null}
        </div>
        {allowLeave && leaveState.status === 'error' && leaveState.message ? (
          <Alert tone="danger" className="text-xs">
            {leaveState.message}
          </Alert>
        ) : null}
        {allowLeave && leaveState.status === 'success' && leaveState.message ? (
          <Alert tone="success" className="text-xs">
            {leaveState.message}
          </Alert>
        ) : null}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <form action={claim}>
        <input type="hidden" name="universityId" value={universityId} />
        <SubmitButton variant="secondary" size="sm" pendingLabel="Saving…">
          I study here
        </SubmitButton>
      </form>
      {claimState.status === 'error' && claimState.message ? (
        <Alert tone="danger" className="text-xs">
          {claimState.message}
        </Alert>
      ) : null}
      {claimState.status === 'error' && claimState.fieldErrors?.universityId ? (
        <Alert tone="danger" className="text-xs">
          {claimState.fieldErrors.universityId}
        </Alert>
      ) : null}
      {claimState.status === 'success' && claimState.message ? (
        <Alert tone="success" className="text-xs">
          {claimState.message}
        </Alert>
      ) : null}
    </div>
  )
}
