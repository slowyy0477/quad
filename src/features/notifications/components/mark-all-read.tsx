'use client'

import { Component, useActionState, useEffect, useRef } from 'react'
import { unstable_rethrow } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { markAllReadFormAction } from '@/features/notifications/actions'
import type { MarkReadOutcome } from '@/features/notifications/types'

const UNCONFIRMED = 'The read status could not be confirmed. Please try again.'

/**
 * Keep the direct Server Action reference in useActionState for progressive
 * forms. A rejected client dispatch is different from a returned server error:
 * React raises it to this boundary. Never render/store/log its raw exception.
 */
class MarkAllReadBoundary extends Component<
  { unread: number },
  { failed: boolean; retrying: boolean }
> {
  state = { failed: false, retrying: false }

  static getDerivedStateFromError(error: unknown) {
    unstable_rethrow(error)
    return { failed: true }
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-xs text-danger-700">{UNCONFIRMED}</p>
          <Button type="button" variant="secondary" className="h-8 px-3 text-xs"
            onClick={() => this.setState({ failed: false, retrying: true })}>
            Try again
          </Button>
        </div>
      )
    }
    return <MarkAllReadForm unread={this.props.unread} retrying={this.state.retrying} />
  }
}

/**
 * Counts/read flags come from the server, not an optimistic badge decrement.
 * A new pending attempt hides the previous outcome; only its settled result is
 * announced. Genuine zero and failed requests are distinct.
 */
function MarkAllReadForm({ unread, retrying }: { unread: number; retrying: boolean }) {
  // A recovered rejected queue still needs confirmation, even if new server
  // props report zero. Seed fixed failure copy, never the rejected exception.
  const initial: MarkReadOutcome | null = retrying ? { ok: false, message: UNCONFIRMED } : null
  const [outcome, formAction, pending] = useActionState<MarkReadOutcome | null, FormData>(
    markAllReadFormAction, initial, '/notifications',
  )
  const submitting = useRef(false)

  useEffect(() => {
    if (!pending) submitting.current = false
  }, [pending, outcome])

  const settled = pending ? null : outcome
  const note = settled ? settled.ok
    ? settled.marked > 0 ? `${settled.marked} marked as read.` : 'Nothing was unread.'
    : settled.message : null

  // Do not remove a pending request or a failed request's retry control merely
  // because an authoritative re-render now reports zero unread.
  if (unread === 0 && !pending && (!outcome || outcome.ok)) {
    return note ? <p role="status" className="text-xs text-ink-muted">{note}</p> : null
  }

  return (
    <form action={formAction} aria-label="Mark all notifications as read" aria-busy={pending}
      className="flex flex-wrap items-center gap-3"
      onSubmit={event => {
        if (pending || submitting.current) {
          event.preventDefault()
          return
        }
        // Also refuse a second native submit before the pending render commits.
        submitting.current = true
      }}>
      {pending ? (
        <p role="status" className="text-xs text-ink-muted">Marking notifications as read…</p>
      ) : note ? (
        <p role={settled?.ok ? 'status' : 'alert'}
          className={`text-xs ${settled?.ok ? 'text-ink-muted' : 'text-danger-700'}`}>
          {note}
        </p>
      ) : null}
      <Button type="submit" variant="secondary" className="h-8 px-3 text-xs"
        disabled={pending} aria-disabled={pending}>
        {pending ? 'Marking…' : 'Mark all as read'}
      </Button>
    </form>
  )
}

/** Existing export/props remain compatible with the notifications page. */
export function MarkAllRead({ unread }: { unread: number }) {
  return <MarkAllReadBoundary unread={unread} />
}
