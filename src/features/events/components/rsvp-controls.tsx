'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { SubmitButton } from '@/components/ui/submit-button'
import { cancelRsvpAction, rsvpAction } from '@/features/events/actions'
import { emptyFormState } from '@/lib/form-state'

/**
 * RSVP.
 *
 * Three states, and each one is stored: nothing, `going`, `interested`. `going` consumes a
 * place under the trigger's row lock; `interested` does not, which is why it is offered
 * when the event is full and why it is the quieter of the two answers -- an attendee list
 * is readable by anyone who can see the event.
 *
 * A full event does not disable a button in silence: the page explains the rule and offers
 * the answer that still works.
 */
export function RsvpControls({
  eventId,
  slug,
  myStatus,
  isSignedIn,
  capacity,
  attendeeCount,
  cancelled,
  hasStarted,
}: {
  eventId: string
  slug: string
  myStatus: string | null
  isSignedIn: boolean
  capacity: number | null
  attendeeCount: number
  cancelled: boolean
  hasStarted: boolean
}) {
  const [rsvpState, rsvpSubmit] = useActionState(rsvpAction, emptyFormState)
  const [cancelState, cancelSubmit] = useActionState(cancelRsvpAction, emptyFormState)

  // The answer shown is the server's, never the action result: `revalidatePath` re-renders
  // this page with the stored row, so a successful write appears because it is in the
  // database, not because a form said so.
  const current = myStatus
  const full = capacity != null && attendeeCount >= capacity
  const failed = [rsvpState, cancelState].find((state) => state.status === 'error' && state.message)
  const succeeded = [rsvpState, cancelState].find((state) => state.status === 'success' && state.message)

  if (!isSignedIn) {
    return (
      <div className="space-y-3">
        <Alert tone="info" title="Sign in to answer">
          An RSVP is attached to an account, which is what lets the organiser see who is coming. Sign in
          and this panel will offer both answers.
        </Alert>
        <Button asChild variant="primary">
          <Link href={`/login?next=/events/${slug}`}>Sign in</Link>
        </Button>
      </div>
    )
  }

  if (cancelled) {
    return (
      <Alert tone="warning" title="This event was cancelled">
        The organiser cancelled it, so it takes no answers. If it is rescheduled, it will appear on the
        calendar again as a new event.
      </Alert>
    )
  }

  if (hasStarted && !current) {
    return (
      <Alert tone="info" title="This event has already started">
        The calendar keeps it for the record, but it is no longer taking answers.
      </Alert>
    )
  }

  return (
    <div className="space-y-4">
      {failed?.message ? (
        <Alert tone="danger" title="That answer was not saved">
          {failed.message}
        </Alert>
      ) : null}

      {succeeded?.message ? <Alert tone="success">{succeeded.message}</Alert> : null}

      {current ? (
        <div className="space-y-3">
          <p className="text-sm text-ink">
            {current === 'going'
              ? 'You are down as going. That takes one of the places.'
              : 'You are down as interested. That does not take a place.'}
          </p>

          <div className="flex flex-wrap items-center gap-3">
            {current === 'interested' ? (
              <form action={rsvpSubmit}>
                <input type="hidden" name="eventId" value={eventId} />
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="status" value="going" />
                <SubmitButton variant="primary" pendingLabel="Saving…">
                  Switch to going
                </SubmitButton>
              </form>
            ) : null}

            <form action={cancelSubmit}>
              <input type="hidden" name="eventId" value={eventId} />
              <input type="hidden" name="slug" value={slug} />
              <SubmitButton variant="secondary" pendingLabel="Removing…">
                Cancel my answer
              </SubmitButton>
            </form>
          </div>

          {current === 'interested' && full ? (
            <p className="text-xs text-ink-muted">
              Every place is taken, so switching to going is not possible until someone cancels.
            </p>
          ) : null}
        </div>
      ) : full ? (
        <div className="space-y-3">
          <Alert tone="info" title="Every place is taken">
            This event has a capacity of <span className="tabular">{capacity}</span> and{' '}
            <span className="tabular">{attendeeCount}</span> people are going. Capacity is checked in the
            database when someone says they are going, so a place cannot be double-booked — and if
            someone cancels, one opens.
          </Alert>

          <form action={rsvpSubmit}>
            <input type="hidden" name="eventId" value={eventId} />
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="status" value="interested" />
            <SubmitButton variant="secondary" pendingLabel="Saving…">
              Mark me interested instead
            </SubmitButton>
          </form>
          <p className="text-xs text-ink-muted">
            Interested does not take a place. It puts your name beside the event, and the organiser can
            see it.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <form action={rsvpSubmit}>
              <input type="hidden" name="eventId" value={eventId} />
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="status" value="going" />
              <SubmitButton variant="primary" pendingLabel="Saving…">
                Going
              </SubmitButton>
            </form>

            <form action={rsvpSubmit}>
              <input type="hidden" name="eventId" value={eventId} />
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="status" value="interested" />
              <SubmitButton variant="secondary" pendingLabel="Saving…">
                Interested
              </SubmitButton>
            </form>
          </div>

          <p className="text-xs text-ink-muted">
            Going takes a place and puts your name on the attendee list, which anyone who can see this
            event can read. Interested does neither.
          </p>
        </div>
      )}
    </div>
  )
}
