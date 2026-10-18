'use client'

import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from '@/components/ui/dialog'
import { closeIdeaAction } from '@/features/ideas/actions'
import { emptyFormState } from '@/lib/form-state'

/**
 * Close an idea.
 *
 * Behind a confirmation whose title names the idea, because a closed idea stops
 * collecting interest and it is the author's own door to shut. The status change is
 * reversible from the edit form, which the dialog says rather than leaving the reader
 * to discover it.
 */
export function CloseIdeaButton({ ideaId, ideaTitle }: { ideaId: string; ideaTitle: string }) {
  const [state, action] = useActionState(closeIdeaAction, emptyFormState)

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm">
          Close this idea
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`Close “${ideaTitle}”?`}
        description="It stays visible as a record, but it stops being presented as looking for people. You can reopen it from the edit form."
      >
        <form action={action} className="space-y-3">
          <input type="hidden" name="ideaId" value={ideaId} />
          {state.status === 'error' && state.message ? (
            <Alert tone="danger">{state.message}</Alert>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="primary">
              Close the idea
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
