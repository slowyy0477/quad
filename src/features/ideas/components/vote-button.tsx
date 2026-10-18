'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { voteIdeaAction } from '@/features/ideas/actions'
import { emptyFormState } from '@/lib/form-state'

/**
 * The upvote.
 *
 * One per person, and the primary key `(idea_id, profile_id)` is what makes that true —
 * a double click is a duplicate-key error the action swallows as "already voted". The
 * count shown is the stored `upvote_count`; a locally incremented number would be a
 * claim rather than a fact if the write were refused.
 */
export function VoteButton({
  ideaId,
  voted,
  count,
}: {
  ideaId: string
  voted: boolean
  count: number
}) {
  const [state, action] = useActionState(voteIdeaAction, emptyFormState)

  return (
    <form action={action} className="inline-flex flex-wrap items-center gap-2">
      <input type="hidden" name="ideaId" value={ideaId} />
      <input type="hidden" name="voted" value={voted ? 'true' : 'false'} />
      <Button type="submit" variant={voted ? 'secondary' : 'ghost'} size="sm" aria-pressed={voted}>
        {voted ? 'Voted' : 'Worth building'}
      </Button>
      <span className="text-xs text-ink-faint tabular">
        {count} <span className="sr-only">votes</span>
      </span>
      {state.status === 'error' && state.message ? (
        <span role="alert" className="text-xs text-danger-600">
          {state.message}
        </span>
      ) : null}
    </form>
  )
}
