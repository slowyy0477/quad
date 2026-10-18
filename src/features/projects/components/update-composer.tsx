'use client'

import { useActionState, useEffect, useRef } from 'react'
import { Alert } from '@/components/ui/alert'
import { Checkbox } from '@/components/ui/checkbox'
import { SubmitButton } from '@/components/ui/submit-button'
import { Textarea } from '@/components/ui/textarea'
import { postUpdateAction } from '@/features/projects/actions'
import { emptyFormState } from '@/lib/form-state'

/**
 * Write an update on the project.
 *
 * The update is a real `posts` row anchored to the project, so it appears in the
 * stream below the moment it is saved and counts towards `projects.post_count`
 * through the trigger that already maintains it.
 *
 * Two things are true and stated: the content is saved once you press the button (a
 * rejected submit keeps the text so nothing is lost), and the "share" checkbox is
 * what decides whether it also appears in the feed. When the project is private the
 * checkbox is not offered — a shared update renders the project's name wherever the
 * post is seen, which would leak a project its owner chose to keep private.
 */
export function UpdateComposer({ slug, canShare }: { slug: string; canShare: boolean }) {
  const [state, action] = useActionState(postUpdateAction, emptyFormState)
  const formRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (state.status === 'success') formRef.current?.reset()
  }, [state])

  return (
    <form ref={formRef} action={action} className="space-y-3">
      {state.status === 'error' && state.message ? (
        <Alert tone="danger" title="The update was not saved">
          {state.message}
        </Alert>
      ) : null}
      {state.status === 'error' && state.fieldErrors?.body ? (
        <Alert tone="danger">{state.fieldErrors.body}</Alert>
      ) : null}
      {state.status === 'success' && state.message ? <Alert tone="success">{state.message}</Alert> : null}

      <input type="hidden" name="slug" value={slug} />

      <Textarea
        name="body"
        rows={3}
        maxLength={5000}
        defaultValue={state.values?.body}
        aria-label="Project update"
        placeholder="What changed since the last update?"
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        {canShare ? (
          <label htmlFor="update-share" className="flex items-start gap-2 text-xs text-ink-muted">
            <span className="pt-0.5">
              <Checkbox id="update-share" name="share" />
            </span>
            <span>
              <span className="block text-ink">Post to the feed as well</span>
              <span className="block">Off keeps it off the feed and only you can see it.</span>
            </span>
          </label>
        ) : (
          <p className="text-xs text-ink-muted">
            This project is private, so updates stay on this page.
          </p>
        )}

        <SubmitButton variant="primary" size="sm" pendingLabel="Saving…">
          Post update
        </SubmitButton>
      </div>
    </form>
  )
}
