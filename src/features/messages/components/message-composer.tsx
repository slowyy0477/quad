'use client'

import { useActionState, useEffect, useRef, useSyncExternalStore } from 'react'
import { Alert } from '@/components/ui/alert'
import { Field } from '@/components/ui/field'
import { SubmitButton } from '@/components/ui/submit-button'
import { Textarea } from '@/components/ui/textarea'
import { sendMessageAction } from '@/features/messages/actions'
import {
  clearDraft,
  serverSnapshot,
  setDraftBody,
  snapshotReader,
  subscribe,
} from '@/features/messages/draft'
import { emptyFormState } from '@/lib/form-state'

/**
 * The message composer.
 *
 * Three things it does, and the first two exist because a composer that loses what
 * you typed is the fastest way to lose a conversation:
 *
 * 1. **A failed send keeps the text.** The draft lives in `sessionStorage` per
 *    conversation (see `features/messages/draft.ts`) and is cleared on success and
 *    only on success, so a refusal from the database — blocked, left, suspended —
 *    arrives with the message still written in front of the reader.
 * 2. **It is not offered when it cannot work.** A blocked or left conversation is
 *    handled by the thread, which renders an explanation instead of this control.
 * 3. **The send comes from the session.** There is no field for the author here,
 *    and there is no field for it in the action: `sender_id` is the session's user,
 *    and the database forces it to `auth.uid()` regardless. A client-supplied
 *    sender is not rejected, it is unrepresentable.
 *
 * An empty box cannot be sent: the button is disabled and Ctrl/Cmd+Enter is
 * guarded, so the reader never spends a round trip to be told what they can see.
 * The server refuses it too (`messages_not_empty`), because the browser is not the
 * boundary.
 */
export function MessageComposer({ conversationId }: { conversationId: string }) {
  const [state, send] = useActionState(sendMessageAction, emptyFormState)
  const formRef = useRef<HTMLFormElement>(null)

  const draft = useSyncExternalStore(
    subscribe,
    snapshotReader(conversationId),
    serverSnapshot,
  )

  // `state` is a fresh object per action result, so this runs once per submit and
  // only acts on a real success. Both things it touches are external systems --
  // storage and the DOM -- which is what an effect is for; it deliberately does not
  // call setState, which is an error in this configuration.
  useEffect(() => {
    if (state.status !== 'success') return
    clearDraft(conversationId)
    formRef.current?.reset()
  }, [state, conversationId])

  const body = draft.body
  const canSend = body.trim().length > 0

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      if (!canSend) return
      formRef.current?.requestSubmit()
    }
  }

  return (
    <form ref={formRef} action={send} className="space-y-2">
      <input type="hidden" name="conversationId" value={conversationId} />

      {state.status === 'error' && state.message ? (
        <Alert tone="danger">{state.message}</Alert>
      ) : null}

      <Field
        id={`message-body-${conversationId}`}
        label="Message"
        hint="Ctrl or ⌘ and Enter sends."
        error={state.fieldErrors?.body}
      >
        {(fieldProps) => (
          <Textarea
            {...fieldProps}
            name="body"
            value={body}
            onChange={(event) => setDraftBody(conversationId, event.target.value)}
            onKeyDown={onKeyDown}
            minRows={2}
            maxLength={4000}
            placeholder="Write a message"
          />
        )}
      </Field>

      {draft.restored ? (
        <p role="status" className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          <span className="rounded-sm border border-hairline bg-paper-sunken px-1.5 py-0.5">
            Draft kept
          </span>
          <span>Your unfinished message was kept in this tab.</span>
          <button
            type="button"
            onClick={() => clearDraft(conversationId)}
            className="rounded text-accent-700 underline underline-offset-2"
          >
            Discard it
          </button>
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-ink-faint">
          {canSend ? '' : 'Write a message first.'}
        </p>
        <SubmitButton variant="primary" size="sm" disabled={!canSend} pendingLabel="Sending…">
          Send
        </SubmitButton>
      </div>
    </form>
  )
}
