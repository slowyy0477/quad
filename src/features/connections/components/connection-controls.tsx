'use client'

import { useActionState, useState } from 'react'
import Link from 'next/link'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { SubmitButton } from '@/components/ui/submit-button'
import {
  acceptConnectionAction,
  blockAction,
  declineConnectionAction,
  removeConnectionAction,
  sendConnectionRequestAction,
  setFollowAction,
  unblockAction,
} from '@/features/connections/actions'
import type { ConnectionState } from '@/features/connections/queries'
import { emptyFormState, type FormState } from '@/lib/form-state'

/**
 * The controls that sit beside a person's name.
 *
 * Three rules hold this file together.
 *
 * 1. **Every state gets exactly one honest offer.** `none` and `rejected` offer a
 *    request, `incoming` offers accept and decline, `outgoing` offers withdrawal,
 *    `connected` offers removal and a message. There is no disabled "Pending"
 *    button that does nothing, which is the usual way this interface lies.
 *
 * 2. **The destructive two are dialogs that name the person.** Removing a
 *    connection and blocking both change something the reader cannot undo from the
 *    button they just pressed, so both open a confirmation with the person's name
 *    in the title and the verb on the button. The safe choice is first in the DOM,
 *    which is where the focus lands.
 *
 * 3. **A failure is rendered next to the control that caused it.** Not a toast:
 *    a message that disappears is worse than no message for anyone reading slowly.
 */

/** A failure or confirmation attached to one control. */
function InlineMessage({ state }: { state: FormState }) {
  if (state.status === 'idle' || !state.message) return null

  return (
    <Alert tone={state.status === 'error' ? 'danger' : 'success'} className="text-xs">
      {state.message}
    </Alert>
  )
}

// -----------------------------------------------------------------------------
// Asking
// -----------------------------------------------------------------------------

function AskControl({
  profileId,
  username,
  label,
  size,
}: {
  profileId: string
  username: string
  label: string
  size: 'sm' | 'default'
}) {
  const [state, action] = useActionState(sendConnectionRequestAction, emptyFormState)

  return (
    <div className="space-y-2">
      <form action={action} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="profileId" value={profileId} />
        <input type="hidden" name="username" value={username} />
        <SubmitButton variant="primary" size={size} pendingLabel="Sending…">
          {label}
        </SubmitButton>
      </form>
      <InlineMessage state={state} />
    </div>
  )
}

// -----------------------------------------------------------------------------
// Answering
// -----------------------------------------------------------------------------

function AnswerControl({
  connectionId,
  username,
  displayName,
  size,
}: {
  connectionId: string
  username: string
  displayName: string
  size: 'sm' | 'default'
}) {
  const [acceptState, accept] = useActionState(acceptConnectionAction, emptyFormState)
  const [declineState, decline] = useActionState(declineConnectionAction, emptyFormState)

  const hidden = (
    <>
      <input type="hidden" name="connectionId" value={connectionId} />
      <input type="hidden" name="username" value={username} />
    </>
  )

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <form action={accept}>
          {hidden}
          <SubmitButton variant="primary" size={size} pendingLabel="Accepting…">
            {/* Their name is in the label because this is the one control on the
                page that answers a specific person, not "the request". */}
            <span className="sr-only">Accept the connection request from </span>
            Accept
          </SubmitButton>
        </form>
        <form action={decline}>
          {hidden}
          <SubmitButton variant="secondary" size={size} pendingLabel="Declining…">
            <span className="sr-only">Decline the connection request from </span>
            Decline
          </SubmitButton>
        </form>
      </div>
      <p className="text-xs text-ink-muted">
        {displayName} asked to connect. Declining keeps the record, so they cannot ask again
        automatically.
      </p>
      <InlineMessage state={acceptState} />
      <InlineMessage state={declineState} />
    </div>
  )
}

// -----------------------------------------------------------------------------
// Severing
// -----------------------------------------------------------------------------

function SeverControl({
  connectionId,
  username,
  displayName,
  wasConnected,
  size,
}: {
  connectionId: string
  username: string
  displayName: string
  wasConnected: boolean
  size: 'sm' | 'default'
}) {
  const [requested, setRequested] = useState(false)
  const [state, action] = useActionState(removeConnectionAction, emptyFormState)

  // The dialog closes on success only, and it closes by derivation rather than by
  // calling setState from an effect: once the action succeeded the row is gone (or
  // has changed hands), so there is nothing left to reopen. On failure it stays
  // open, because closing it would hide the sentence explaining what went wrong at
  // the moment it is needed.
  const open = requested && state.status !== 'success'

  const verb = wasConnected ? 'Remove connection' : 'Withdraw request'

  return (
    <Dialog open={open} onOpenChange={setRequested}>
      <DialogTrigger asChild>
        <Button variant={wasConnected ? 'secondary' : 'ghost'} size={size}>
          {verb}
        </Button>
      </DialogTrigger>

      <DialogContent
        title={wasConnected ? `Remove ${displayName}?` : `Withdraw the request to ${displayName}?`}
        description={
          wasConnected
            ? `You and ${displayName} will no longer be connected. Your posts and profile keep their current visibility; nothing else changes.`
            : `The request to ${displayName} will be deleted. They will not be told, and you can ask again later.`
        }
      >
        <form action={action} className="space-y-4">
          <input type="hidden" name="connectionId" value={connectionId} />
          <input type="hidden" name="username" value={username} />
          <input type="hidden" name="wasConnected" value={wasConnected ? 'true' : 'false'} />

          {state.status === 'error' && state.message ? (
            <Alert tone="danger" className="text-xs">
              {state.message}
            </Alert>
          ) : null}

          <DialogFooter>
            <DialogClose asChild>
              {/* First in the DOM, so it takes focus: the safe way out. */}
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <SubmitButton
              variant={wasConnected ? 'danger' : 'primary'}
              pendingLabel="Working…"
            >
              {verb}
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// -----------------------------------------------------------------------------
// Blocking
// -----------------------------------------------------------------------------

/**
 * The block control.
 *
 * The consequence is spelled out with the person's name in the title, because a
 * block here is bilateral and silent: both profiles stop resolving, the connection
 * and any follow are deleted, and the other person is never told. None of that is
 * guessable from the word "Block".
 *
 * Unblocking is a plain button rather than a dialog. It restores visibility and
 * destroys nothing, so asking for confirmation would be theatre.
 */
export function BlockControl({
  profileId,
  username,
  displayName,
  isBlockingThem,
  signedIn,
  size,
}: {
  profileId: string
  username: string
  displayName: string
  isBlockingThem: boolean
  signedIn: boolean
  size: 'sm' | 'default'
}) {
  const [requested, setRequested] = useState(false)
  const [blockState, block] = useActionState(blockAction, emptyFormState)
  const [unblockState, unblock] = useActionState(unblockAction, emptyFormState)

  // Same derivation as the sever dialog: closed once the block exists, open
  // afterwards, which is exactly when the message about a failed attempt matters.
  const open = requested && blockState.status !== 'success'

  if (!signedIn) return null

  if (isBlockingThem) {
    return (
      <div className="space-y-2">
        <form action={unblock}>
          <input type="hidden" name="profileId" value={profileId} />
          <input type="hidden" name="username" value={username} />
          <SubmitButton variant="secondary" size={size} pendingLabel="Unblocking…">
            Unblock {displayName}
          </SubmitButton>
        </form>
        <InlineMessage state={unblockState} />
      </div>
    )
  }

  return (
    <Dialog open={open} onOpenChange={setRequested}>
      <DialogTrigger asChild>
        <Button variant="ghost" size={size}>
          Block {displayName}
        </Button>
      </DialogTrigger>

      <DialogContent
        title={`Block ${displayName}?`}
        description={`${displayName} will not be able to find your profile, follow you or send you a request, and you will not see theirs. Any connection or follow between you is removed. They are not told that you blocked them.`}
      >
        <form action={block} className="space-y-4">
          <input type="hidden" name="profileId" value={profileId} />
          <input type="hidden" name="username" value={username} />

          <Field
            id="block-reason"
            label="Why (optional)"
            hint="Stored with the block and visible only to you. It is a note to yourself, not a message to them."
            error={blockState.fieldErrors?.reason}
          >
            {(field) => <Input {...field} name="reason" maxLength={500} />}
          </Field>

          {blockState.status === 'error' && blockState.message ? (
            <Alert tone="danger" className="text-xs">
              {blockState.message}
            </Alert>
          ) : null}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <SubmitButton variant="danger" pendingLabel="Blocking…">
              Block {displayName}
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// -----------------------------------------------------------------------------
// Following
// -----------------------------------------------------------------------------

function FollowControl({
  profileId,
  username,
  isFollowing,
  size,
}: {
  profileId: string
  username: string
  isFollowing: boolean
  size: 'sm' | 'default'
}) {
  const [state, action] = useActionState(setFollowAction, emptyFormState)

  return (
    <div className="space-y-2">
      <form action={action} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="profileId" value={profileId} />
        <input type="hidden" name="username" value={username} />
        <input type="hidden" name="follow" value={isFollowing ? 'false' : 'true'} />
        <SubmitButton variant="secondary" size={size} pendingLabel="Working…">
          {isFollowing ? 'Following' : 'Follow'}
        </SubmitButton>
      </form>
      <InlineMessage state={state} />
    </div>
  )
}

// -----------------------------------------------------------------------------
// The whole set, chosen by state
// -----------------------------------------------------------------------------

export function ConnectionControls({
  profileId,
  username,
  displayName,
  state,
  connectionId,
  isFollowing,
  isBlockingThem,
  signedIn,
  isSelf = false,
  showBlock = false,
  showFollow = true,
  size = 'default',
}: {
  profileId: string
  username: string
  displayName: string
  state: ConnectionState
  connectionId: string | null
  isFollowing: boolean
  isBlockingThem: boolean
  signedIn: boolean
  isSelf?: boolean
  /** Only the profile page offers blocking. A row-level block button is a mis-tap away. */
  showBlock?: boolean
  /**
   * Whether to offer following. The connections list turns it off: that query does
   * not read the reader's follow rows, and a "Follow" button next to someone the
   * reader already follows would be a label that is not true.
   */
  showFollow?: boolean
  size?: 'sm' | 'default'
}) {
  if (isSelf) return null

  const block = showBlock ? (
    <BlockControl
      profileId={profileId}
      username={username}
      displayName={displayName}
      isBlockingThem={isBlockingThem}
      signedIn={signedIn}
      size={size}
    />
  ) : null

  if (!signedIn) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="primary" size={size}>
          <Link href={`/login?next=/u/${username}`}>Sign in to connect</Link>
        </Button>
        {block}
      </div>
    )
  }

  return (
    <div className="flex flex-col items-start gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {state === 'connected' ? (
          <>
            <Badge tone="success">Connected</Badge>
            <Button asChild variant="secondary" size={size}>
              <Link href="/messages">Message</Link>
            </Button>
            {connectionId ? (
              <SeverControl
                connectionId={connectionId}
                username={username}
                displayName={displayName}
                wasConnected
                size={size}
              />
            ) : null}
            {showFollow ? (
              <FollowControl
                profileId={profileId}
                username={username}
                isFollowing={isFollowing}
                size={size}
              />
            ) : null}
          </>
        ) : null}

        {state === 'outgoing' ? (
          <>
            <Badge tone="neutral">Request sent</Badge>
            {connectionId ? (
              <SeverControl
                connectionId={connectionId}
                username={username}
                displayName={displayName}
                wasConnected={false}
                size={size}
              />
            ) : null}
          </>
        ) : null}

        {state === 'incoming' && connectionId ? (
          <AnswerControl
            connectionId={connectionId}
            username={username}
            displayName={displayName}
            size={size}
          />
        ) : null}

        {state === 'none' ? (
          <AskControl profileId={profileId} username={username} label="Connect" size={size} />
        ) : null}

        {state === 'rejected' ? (
          <AskControl
            profileId={profileId}
            username={username}
            label="Ask again"
            size={size}
          />
        ) : null}

        {showFollow && state !== 'connected' && state !== 'incoming' ? (
          <FollowControl
            profileId={profileId}
            username={username}
            isFollowing={isFollowing}
            size={size}
          />
        ) : null}

        {block}
      </div>

      {showFollow && state !== 'incoming' ? (
        <p className="text-xs text-ink-faint">
          {state === 'connected'
            ? 'Following is separate from connecting and can be changed on its own.'
            : 'Connecting works both ways once they accept. Following does not ask.'}
        </p>
      ) : null}
    </div>
  )
}
