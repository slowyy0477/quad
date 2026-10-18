'use client'

import { useActionState } from 'react'
import { Star } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toggleStarAction } from '@/features/projects/actions'
import { emptyFormState } from '@/lib/form-state'

/**
 * Star a project.
 *
 * The count shown is the stored `star_count`, never a locally incremented number: if
 * the write is refused the count does not move, so the control cannot lie. The
 * current state is posted rather than read first, and a double click produces a
 * duplicate-key error the action treats as "already starred".
 */
export function StarButton({
  projectId,
  slug,
  starred,
  starCount,
}: {
  projectId: string
  slug: string
  starred: boolean
  starCount: number
}) {
  const [state, action] = useActionState(toggleStarAction, emptyFormState)

  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="starred" value={starred ? 'true' : 'false'} />
      <Button type="submit" variant={starred ? 'secondary' : 'ghost'} size="sm" aria-pressed={starred}>
        <Star className="size-4" aria-hidden="true" fill={starred ? 'currentColor' : 'none'} />
        {starred ? 'Starred' : 'Star'}
      </Button>
      <span className="text-xs text-ink-faint tabular">
        {starCount} <span className="sr-only">stars</span>
      </span>
      {state.status === 'error' && state.message ? (
        <span role="alert" className="text-xs text-danger-600">
          {state.message}
        </span>
      ) : null}
    </form>
  )
}
