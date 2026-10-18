'use client'

import { useActionState } from 'react'
import { Bookmark } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toggleOpportunitySaveAction } from '@/features/opportunities/actions'
import { emptyFormState } from '@/lib/form-state'

/**
 * Save a listing.
 *
 * This is the only per-reader state the schema stores about a listing, so it is the only
 * one the button may claim. It is labelled "Save", not "Applied": `opportunity_saves` is a
 * private bookmark, and there is no applications table to record an application in.
 *
 * The count beside it is `save_count`, the trigger-maintained column, never a local
 * increment -- if the write is refused the number does not move, so the control cannot
 * lie about what happened.
 */
export function SaveOpportunityButton({
  opportunityId,
  slug,
  saved,
  saveCount,
}: {
  opportunityId: string
  slug: string
  saved: boolean
  saveCount: number
}) {
  const [state, action] = useActionState(toggleOpportunitySaveAction, emptyFormState)

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="opportunityId" value={opportunityId} />
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="saved" value={saved ? 'true' : 'false'} />

      <Button type="submit" variant={saved ? 'secondary' : 'ghost'} size="sm" aria-pressed={saved}>
        <Bookmark className="size-4" aria-hidden="true" fill={saved ? 'currentColor' : 'none'} />
        {saved ? 'Saved' : 'Save'}
      </Button>

      <span className="text-xs text-ink-faint tabular">
        {saveCount} <span className="sr-only">people saved this</span>
      </span>

      {state.status === 'error' && state.message ? (
        <span role="alert" className="text-xs font-medium text-danger-600">
          {state.message}
        </span>
      ) : null}
    </form>
  )
}
