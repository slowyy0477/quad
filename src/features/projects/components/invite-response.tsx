'use client'

import Link from 'next/link'
import { useActionState, useId } from 'react'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Surface } from '@/components/ui/surface'
import { respondToProjectInviteAction } from '@/features/projects/invite-actions'
import type { InviteResponseState, ProjectInvitation } from '@/features/projects/invitations'

const INITIAL: InviteResponseState = { status: 'idle' }

/** Only pass the recipient DTO from listMyProjectInvitations/getMyProjectInvitation. */
export function InviteResponse({ invitation }: { invitation: ProjectInvitation }) {
  const [state, action, pending] = useActionState(respondToProjectInviteAction, INITIAL)
  const headingId = useId()
  const feedbackId = useId()
  const resolved = state.status === 'success' && Boolean(state.response)
  return (
    <Surface as="section" className="p-4 sm:p-5" aria-labelledby={headingId}>
      <h2 id={headingId} className="text-base font-semibold text-ink">
        Invitation to {invitation.projectTitle}
      </h2>
      <p className="mt-1 text-sm text-ink-muted">
        This invitation is private. Accepting adds you as a member; declining does not join the team.
        {invitation.projectVisibility === 'private' ? ' The project stays private.' : ''}
      </p>
      {invitation.proposedRole ? <p className="mt-3 text-sm text-ink">Proposed work: {invitation.proposedRole}</p> : null}
      {invitation.message ? <p className="mt-3 text-sm whitespace-pre-wrap text-ink-muted">{invitation.message}</p> : null}
      <div id={feedbackId} className="mt-3" role={state.status === 'error' ? 'alert' : 'status'} aria-live={state.status === 'error' ? 'assertive' : 'polite'} aria-atomic="true">
        {state.message ? <Alert role="presentation" tone={state.status === 'error' ? 'danger' : 'success'}>{state.message}</Alert> : null}
        {pending ? <p className="text-sm text-ink-muted">Saving your response…</p> : null}
      </div>
      {resolved ? (
        state.projectPath ? <Link href={state.projectPath} className="mt-3 inline-block text-sm font-medium text-ink underline underline-offset-4">Open project</Link> : null
      ) : (
        <form action={action} aria-busy={pending} aria-describedby={feedbackId} className="mt-3">
          <input type="hidden" name="inviteId" value={invitation.id} />
          {!invitation.canAccept ? (
            <p className="mb-3 text-sm text-ink-muted">
              {invitation.refusalReason === 'full' ? 'The team is currently full. You can decline or check again later.' :
                invitation.refusalReason === 'already_member' ? 'You are already a member. You can decline this outstanding invitation.' :
                  'Joining is not currently available. You can still decline.'}
            </p>
          ) : <p className="mb-3 text-sm text-ink-faint">Membership and team capacity are checked again when you accept.</p>}
          <fieldset disabled={pending} className="flex flex-wrap gap-2">
            <legend className="sr-only">Respond to this invitation</legend>
            <Button type="submit" name="response" value="accepted" size="sm" disabled={pending || !invitation.canAccept}>Accept invitation</Button>
            <Button type="submit" name="response" value="declined" size="sm" variant="secondary" disabled={pending}>Decline invitation</Button>
          </fieldset>
        </form>
      )}
    </Surface>
  )
}
