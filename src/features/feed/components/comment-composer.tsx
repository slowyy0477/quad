'use client'

import { useActionState, useEffect, useRef, useState } from 'react'
import { Alert } from '@/components/ui/alert'
import { SubmitButton } from '@/components/ui/submit-button'
import { Textarea } from '@/components/ui/textarea'
import { createCommentAction } from '@/features/feed/actions'
import { emptyCommentState } from '@/features/feed/form-state'

/**
 * The comment composer.
 *
 * Same three rules as the post composer, for the same reason: it autosizes, it
 * shows its counter only near the limit, and `Cmd/Ctrl+Enter` submits. It does not
 * keep a draft in `sessionStorage` — a comment is a sentence or two and a restored
 * draft in the middle of someone else's thread is more confusing than helpful.
 *
 * The post id is a hidden field, and the author is not a field at all: the insert
 * carries no `author_id`, because `comments_before_write` sets it from the session
 * and a comment cannot be attributed to anyone else even by a hand-built request.
 */
export function CommentComposer({
  postId,
  parentId,
  placeholder = 'Add a comment',
  autoFocus = false,
}: {
  postId: string
  parentId?: string
  placeholder?: string
  autoFocus?: boolean
}) {
  const [state, action] = useActionState(createCommentAction, emptyCommentState)
  const formRef = useRef<HTMLFormElement>(null)
  const [body, setBody] = useState('')
  const [handled, setHandled] = useState(state)

  // A successful submit clears the field. Adjusting state during render is React's
  // documented pattern for resetting state in response to something that changed
  // outside the component, and it is not an effect, so there is no second render to
  // pay for. `state` is a fresh object per action result, so this fires once each.
  if (handled !== state) {
    setHandled(state)
    if (state.status === 'success') setBody('')
  }

  useEffect(() => {
    // The form element is an external system: resetting it drops the values the
    // browser kept for the fields this component does not control.
    if (state.status === 'success') formRef.current?.reset()
  }, [state])

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      formRef.current?.requestSubmit()
    }
  }

  return (
    <form ref={formRef} action={action} className="space-y-2">
      <input type="hidden" name="postId" value={postId} />
      {parentId ? <input type="hidden" name="parentId" value={parentId} /> : null}

      {state.message ? <Alert tone="danger">{state.message}</Alert> : null}

      <Textarea
        name="body"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={onKeyDown}
        minRows={2}
        maxLength={2000}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={parentId ? 'Your reply' : 'Your comment'}
        aria-invalid={state.fieldErrors?.body ? true : undefined}
        aria-describedby={state.fieldErrors?.body ? `comment-error-${parentId ?? postId}` : undefined}
      />

      {state.fieldErrors?.body ? (
        <p
          id={`comment-error-${parentId ?? postId}`}
          role="alert"
          className="text-xs font-medium text-danger-600"
        >
          {state.fieldErrors.body}
        </p>
      ) : null}

      <div className="flex justify-end">
        <SubmitButton variant="secondary" size="sm" pendingLabel="Sending…">
          {parentId ? 'Reply' : 'Comment'}
        </SubmitButton>
      </div>
    </form>
  )
}
