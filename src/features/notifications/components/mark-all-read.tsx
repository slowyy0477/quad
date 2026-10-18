'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { markAllReadAction } from '@/features/notifications/actions'

/**
 * "Mark all as read".
 *
 * The count comes from the server on every render rather than being decremented here: the
 * button is an action on a set of rows, and pretending locally that they are read would
 * put the badge and the list out of step the moment the request failed.
 *
 * `marked` is what the database changed, so the sentence after the click is a fact. Zero
 * is possible and is not an error — another tab may have marked them first.
 */
export function MarkAllRead({ unread }: { unread: number }) {
  const [pending, startTransition] = useTransition()
  const [note, setNote] = useState<string | null>(null)

  if (unread === 0) {
    return note ? (
      <p role="status" className="text-xs text-ink-muted">
        {note}
      </p>
    ) : null
  }

  return (
    <div className="flex items-center gap-3">
      {note ? (
        <p role="status" className="text-xs text-ink-muted">
          {note}
        </p>
      ) : null}
      <Button
        variant="secondary"
        className="h-8 px-3 text-xs"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const outcome = await markAllReadAction()
            setNote(
              outcome.ok
                ? outcome.marked > 0
                  ? `${outcome.marked} marked as read.`
                  : 'Nothing was unread.'
                : outcome.message,
            )
          })
        }
      >
        {pending ? 'Marking…' : 'Mark all as read'}
      </Button>
    </div>
  )
}
