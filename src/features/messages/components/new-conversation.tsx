'use client'

import { useActionState, useId, useState } from 'react'
import Link from 'next/link'
import { Alert } from '@/components/ui/alert'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import { createGroupConversationAction, startConversationAction } from '@/features/messages/actions'
import { GROUP_REACHABILITY_COPY } from '../group-contract'
import type { GroupCreateState } from '../types'
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
  const formId = useId()

  return (
    <div className="space-y-3">
    <form action={start} className="space-y-3">
      {state.status === 'error' && state.message ? (
        <Alert tone="danger">{state.message}</Alert>
      ) : null}

      <Field
        id={`${formId}-username`}
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
      <details className="border-t border-hairline pt-3">
        <summary className="cursor-pointer rounded text-sm text-ink-muted hover:text-ink">
          Create group
        </summary>
        <div className="mt-3"><CreateGroupForm /></div>
      </details>
    </div>
  )
}

export function CreateGroupForm() {
  const initial: GroupCreateState = emptyFormState
  const [state, create, pending] = useActionState(createGroupConversationAction, initial)
  const formId = useId()
  // Controlled inputs survive a refused action, including a stale consent check.
  const [title, setTitle] = useState('')
  const [handles, setHandles] = useState('')
  return (
    <form action={create} className="space-y-3">
      <p className="text-xs text-ink-muted">{GROUP_REACHABILITY_COPY}</p>
      <p className="text-xs text-ink-faint">Up to 10 handles now; 20 active people per group, including you.</p>
      <fieldset disabled={pending} className="space-y-3">
        <Field id={`${formId}-title`} label="Group name" required error={state.fieldErrors?.title}>
          {props => <Input {...props} name="title" value={title} onChange={event => setTitle(event.target.value)} maxLength={120} />}
        </Field>
        <Field id={`${formId}-handles`} label="Group handles" required
          hint="Accepted connections, separated by commas or spaces."
          error={state.fieldErrors?.handles}>
          {props => <Input {...props} name="handles" value={handles} onChange={event => setHandles(event.target.value)}
            maxLength={500} autoComplete="off" autoCapitalize="none" spellCheck={false} />}
        </Field>
      </fieldset>
      {state.message ? <Alert tone={state.status === 'success' ? 'success' : 'danger'}>{state.message}</Alert> : null}
      {state.status === 'success' && state.conversationId ? (
        <Link href={`/messages?c=${state.conversationId}`} className="text-sm text-accent-700 underline underline-offset-2">
          Open group
        </Link>
      ) : null}
      <div>
        <SubmitButton variant="secondary" size="sm" pendingLabel="Creating…">Create group</SubmitButton>
      </div>
    </form>
  )
}
