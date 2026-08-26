'use client'

import { useActionState, useEffect, useRef } from 'react'
import { Alert } from '@/components/ui/alert'
import { Select, Textarea } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import { Surface } from '@/components/ui/surface'
import { createPostAction } from '@/features/feed/actions'
import { emptyPostState } from '@/features/feed/form-state'

/**
 * Post composer.
 *
 * The visibility select defaults to `university` rather than `public`. A default
 * has more effect on what people share than any explanation next to it, and the
 * safer default is the one where a hastily written post reaches classmates rather
 * than the open web.
 *
 * The textarea clears itself only on a successful submit, so a rejected post is
 * still there to fix rather than lost.
 */
export function PostComposer({ authorFirstName }: { authorFirstName: string }) {
  const [state, action] = useActionState(createPostAction, emptyPostState)
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (state.status === 'success') formRef.current?.reset()
  }, [state])

  return (
    <Surface as="section" className="p-4" aria-labelledby="composer-heading">
      <h2 id="composer-heading" className="sr-only">
        Write a post
      </h2>

      <form ref={formRef} action={action} className="space-y-3">
        {state.message ? <Alert tone="danger">{state.message}</Alert> : null}

        <Textarea
          name="body"
          rows={3}
          defaultValue={state.body}
          placeholder={`What are you working on, ${authorFirstName}?`}
          aria-label="Post body"
          aria-invalid={state.fieldErrors?.body ? true : undefined}
          aria-describedby={state.fieldErrors?.body ? 'composer-body-error' : undefined}
          maxLength={5000}
          className="border-transparent bg-transparent px-0 hover:border-transparent focus-visible:border-transparent"
        />

        {state.fieldErrors?.body ? (
          <p id="composer-body-error" role="alert" className="text-xs font-medium text-danger-600">
            {state.fieldErrors.body}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-3">
          <label className="flex items-center gap-2 text-xs text-ink-muted">
            Visible to
            <Select name="visibility" defaultValue="university" className="w-auto min-h-8 py-1 text-xs">
              <option value="public">Anyone</option>
              <option value="university">My university</option>
              <option value="connections">My connections</option>
              <option value="private">Only me</option>
            </Select>
          </label>

          <SubmitButton variant="primary" size="sm" pendingLabel="Posting…">
            Post
          </SubmitButton>
        </div>
      </form>
    </Surface>
  )
}
