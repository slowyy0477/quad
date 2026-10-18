'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Field } from '@/components/ui/field'
import { Input, Textarea } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import { expressInterestAction, withdrawInterestAction } from '@/features/ideas/actions'
import { emptyFormState } from '@/lib/form-state'

/**
 * "I would help build this."
 *
 * The offer is per person — the primary key on `idea_interest` is `(idea_id,
 * profile_id)` and the trigger forces `profile_id` to the session, so nobody can make
 * an offer on someone else's behalf. Once there is an offer a second one is a duplicate
 * key, which the action reports as "already said you would help" rather than an error.
 *
 * An idea's own author cannot offer to help build their own idea; the trigger refuses
 * it, and this control is not rendered for them at all.
 */
export function InterestForm({
  ideaId,
  hasExpressedInterest,
  ownInterest,
}: {
  ideaId: string
  hasExpressedInterest: boolean
  ownInterest: { message: string | null; offering: string | null } | null
}) {
  const [interestState, interestAction] = useActionState(expressInterestAction, emptyFormState)
  const [withdrawState, withdrawAction] = useActionState(withdrawInterestAction, emptyFormState)

  if (hasExpressedInterest || interestState.status === 'success') {
    return (
      <div className="space-y-3">
        <Alert tone="success" title="Your offer is with the author">
          {interestState.message ?? 'They can read it, and you will be invited if the idea becomes a project.'}
        </Alert>

        {ownInterest?.message || ownInterest?.offering ? (
          <div className="rounded border border-hairline p-3 text-sm">
            {ownInterest.offering ? <p className="text-ink">You offered: {ownInterest.offering}</p> : null}
            {ownInterest.message ? (
              <p className="mt-1 whitespace-pre-wrap text-ink-muted">{ownInterest.message}</p>
            ) : null}
          </div>
        ) : null}

        <form action={withdrawAction}>
          <input type="hidden" name="ideaId" value={ideaId} />
          {withdrawState.status === 'error' && withdrawState.message ? (
            <p role="alert" className="mb-2 text-xs font-medium text-danger-600">
              {withdrawState.message}
            </p>
          ) : null}
          <SubmitButton variant="ghost" size="sm" pendingLabel="Taking it back…">
            Take back my offer
          </SubmitButton>
        </form>
      </div>
    )
  }

  return (
    <form action={interestAction} className="space-y-4">
      {interestState.status === 'error' && interestState.message ? (
        <Alert tone="danger" title="That was not recorded">
          {interestState.message}
        </Alert>
      ) : null}

      <input type="hidden" name="ideaId" value={ideaId} />

      <Field
        id="interest-offering"
        label="What you would bring"
        hint="Optional, a phrase. “I can do the iOS side.”"
        error={interestState.fieldErrors?.offering}
      >
        {(props) => <Input {...props} name="offering" maxLength={200} autoComplete="off" />}
      </Field>

      <Field
        id="interest-message"
        label="Message to the author"
        hint="Optional. A bare signal gives them nothing to act on, so a sentence helps."
        error={interestState.fieldErrors?.message}
      >
        {(props) => <Textarea {...props} name="message" rows={3} maxLength={1000} />}
      </Field>

      <SubmitButton variant="primary" pendingLabel="Sending…">
        I would help build this
      </SubmitButton>
    </form>
  )
}
