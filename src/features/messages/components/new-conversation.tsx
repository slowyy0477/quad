'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import { startConversationAction } from '@/features/messages/actions'
import { emptyFormState } from '@/lib/form-state'

/**
 * Start a conversation, by handle.
 *
 * This is the one entry point this route owns for opening a new thread, and it
 * exists because the alternative — hiding the action entirely and letting people
 * discover the refusal — is the thing requirement 5 of the milestone rules out:
 * *"your interface must not offer an action that will be refused — check first, and
 * where the refusal is server-side, show its message."*
 *
 * The **check happens on the server**, in the action, before
 * `start_direct_conversation` is called: the readable half of `app.can_message` is
 * mirrored in `queries.ts` (the function itself lives in a schema PostgREST does
 * not expose) and a provable refusal comes back as a sentence instead of a failed
 * round trip. The half that cannot be mirrored — a block against the reader — is
 * invisible by policy, so it is not guessed at: the function refuses, and that
 * refusal is the sentence the reader sees.
 *
 * `?to=<handle>` renders the same form with the field filled in, which is the
 * address a profile page's "Message" control should point at.
 */
export function NewConversationForm({ defaultUsername = '' }: { defaultUsername?: string }) {
  const [state, start] = useActionState(startConversationAction, emptyFormState)

  return (
    <form action={start} className="space-y-3">
      {state.status === 'error' && state.message ? (
        <Alert tone="danger">{state.message}</Alert>
      ) : null}

      <Field
        id="new-conversation-username"
        label="Their handle"
        hint="The username after the @ on their profile."
        error={state.fieldErrors?.username}
        required
      >
        {(fieldProps) => (
          <Input
            {...fieldProps}
            name="username"
            defaultValue={defaultUsername || state.values?.username || ''}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="ana.cruz"
          />
        )}
      </Field>

      <SubmitButton variant="secondary" size="sm" pendingLabel="Opening…">
        Start conversation
      </SubmitButton>
    </form>
  )
}
