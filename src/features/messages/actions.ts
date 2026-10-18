'use server'

/**
 * Messaging writes.
 *
 * Four actions, and the security-relevant thing about all of them is what is
 * *absent* from the form data. No `sender_id`: the row's author is the session's
 * user, and `app.messages_before_write` overwrites the column with `auth.uid()`
 * anyway, so a caller who builds the request by hand still cannot attribute a
 * message to anyone but themselves. No `unread_count`: it is not in the client's
 * UPDATE grant, and "mark read" is a security-definer function that resets the
 * counter and the timestamp together so the two cannot disagree.
 *
 * Every one of these goes through the wrapper in `lib/action`, which is the
 * documented single write path (ARCHITECTURE §4): zod parse → authentication →
 * account status → the write → revalidate. The one thing the wrapper deliberately
 * cannot do is authorise; that is row level security's job, and each write below
 * names the policy that decides it.
 *
 * Nothing from Postgres reaches the browser. `describeWriteError` logs the code
 * and the message server-side and returns a sentence; the trigger hints are matched
 * on `hint`, never on message text, which is not a stable interface.
 */

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { ActionError, action, formInput, requireActiveAccount, toFormState } from '@/lib/action'
import type { FormState } from '@/lib/form-state'
import { getMessagingPermission } from '@/features/messages/queries'
import {
  escapeHandle,
  markReadSchema,
  sendMessageSchema,
  setMutedSchema,
  startConversationSchema,
} from '@/features/messages/schemas'
import type { MarkReadOutcome, MuteOutcome } from '@/features/messages/types'

/**
 * The refusals the messaging triggers raise, by hint.
 *
 * `app.messages_before_write` raises `blocked` and `not_participant`;
 * `public.start_direct_conversation` raises `messaging_not_permitted` for every
 * reason a conversation cannot be opened — blocked, preference, suspended, missing
 * — precisely so the response cannot be used to probe someone's settings. So the
 * sentence here is deliberately the same whichever of those it was.
 */
const SEND_REFUSALS: Record<string, string> = {
  blocked: 'You cannot message this person: one of you has blocked the other.',
  not_participant: 'This conversation is not open to you any more, so nothing was sent.',
}

const START_REFUSALS: Record<string, string> = {
  messaging_not_permitted:
    'You cannot message this person. They may have messages turned off, or one of you may ' +
    'have blocked the other.',
  self_conversation: 'You cannot start a conversation with yourself.',
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

const sendMessage = action(sendMessageSchema)
  .use(requireActiveAccount)
  .run(async ({ input, supabase, user }) => {
    const { error } = await supabase.from('messages').insert({
      conversation_id: input.conversationId,
      /*
       * The session's id. The column has no default — which is why the generated
       * Insert type requires it — and `app.messages_before_write` forces it to
       * auth.uid() for any non-privileged writer, and `messages_insert_participant`
       * checks `sender_id = auth.uid()` a third time. Three layers, and not one of
       * them reads a form field, so a client-supplied sender is not merely
       * rejected; it is not a thing this code has a place to put.
       */
      sender_id: user.id,
      body: input.body,
    })

    if (error) {
      console.error('[messages:send]', error.code, error.message, error.hint ?? '')
      const refusal = error.hint ? SEND_REFUSALS[error.hint] : undefined
      if (refusal) throw new ActionError(refusal, { body: 'This message was not sent.' })
      throw error
    }

    // Both panes: the thread gains the message and the list gains its preview and
    // its new position, which is the same path.
    revalidatePath('/messages')

    return { message: 'Sent.' }
  })

export async function sendMessageAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await sendMessage(formInput(formData))
  return toFormState(result, 'Sent.', formData)
}

// ---------------------------------------------------------------------------
// Starting one
// ---------------------------------------------------------------------------

const startConversation = action(startConversationSchema)
  .use(requireActiveAccount)
  .run(async ({ input, supabase, user }) => {
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, username, display_name')
      .ilike('username', escapeHandle(input.username))
      .is('deleted_at', null)
      .maybeSingle<{ id: string; username: string; display_name: string }>()

    if (profileError) {
      console.error('[messages:start:lookup]', profileError.code, profileError.message)
      throw profileError
    }

    if (!profile) {
      throw new ActionError(
        'No one here uses that handle. Check the spelling, or find them from the feed.',
        { username: 'That handle is not in use.' },
      )
    }

    /*
     * The courtesy check, before the write. `app.can_message` is the rule, but it
     * lives in a schema PostgREST does not expose, so the readable half of it is
     * mirrored in queries.ts and asked first. This is not the boundary: it cannot
     * see a block against the reader, and when it cannot tell, it allows and lets
     * the function decide — whose refusal arrives below as a sentence rather than
     * as a silent nothing.
     */
    const permission = await getMessagingPermission(user.id, profile.id)
    if (permission.state === 'refused') throw new ActionError(permission.reason)

    const { data, error } = await supabase.rpc('start_direct_conversation', {
      p_other_user: profile.id,
    })

    if (error) {
      console.error('[messages:start]', error.code, error.message, error.hint ?? '')
      const refusal = error.hint ? START_REFUSALS[error.hint] : undefined
      if (refusal) throw new ActionError(refusal)
      throw error
    }

    revalidatePath('/messages')

    // Idempotent by design: the pair index means this is the same conversation
    // whoever asks and however many times.
    return { conversationId: data as unknown as string, username: profile.username }
  })

export async function startConversationAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = await startConversation(formInput(formData))

  // The redirect is outside the wrapper on purpose: `redirect()` signals by
  // throwing, and the wrapper's job is to turn anything thrown into a refusal, so
  // a redirect raised inside it would arrive as "that could not be saved".
  if (!result.ok) return toFormState(result, '', formData)

  redirect(`/messages?c=${result.value.conversationId}`)
}

// ---------------------------------------------------------------------------
// Read state
// ---------------------------------------------------------------------------

const markRead = action(markReadSchema)
  .use(requireActiveAccount)
  .run(async ({ input, supabase }) => {
    /*
     * A function, not an UPDATE. `unread_count` is deliberately absent from the
     * client's UPDATE grant on conversation_participants, so that "mark as read"
     * cannot be forged into "mark unread for everyone else"; the function verifies
     * participation, declares the write trusted, and stamps `unread_count = 0` and
     * `last_read_at = now()` in one statement, scoped to the caller's own row.
     */
    const { error } = await supabase.rpc('mark_conversation_read', {
      p_conversation_id: input.conversationId,
    })

    if (error) {
      console.error('[messages:markRead]', error.code, error.message)
      if (error.code === '42501') {
        throw new ActionError('That conversation is not yours, so nothing was marked read.')
      }
      throw error
    }

    revalidatePath('/messages')

    return { marked: true }
  })

/**
 * Called from an effect when a thread is opened, and again when a new message
 * lands in a thread the reader is looking at.
 *
 * It reports `marked: true` only for a call the database accepted. The caller uses
 * that to decide whether anything needs re-rendering, which is why a refusal here
 * is not thrown: a failed mark-read is not worth an error dialog on a page the
 * reader is only trying to read.
 */
export async function markConversationReadAction(conversationId: string): Promise<MarkReadOutcome> {
  const result = await markRead({ conversationId })
  if (result.ok) return { ok: true, marked: true }
  return { ok: false, message: result.error }
}

// ---------------------------------------------------------------------------
// Muting
// ---------------------------------------------------------------------------

const setMuted = action(setMutedSchema)
  .use(requireActiveAccount)
  .run(async ({ input, supabase, user }) => {
    const { data, error } = await supabase
      .from('conversation_participants')
      .update({ is_muted: input.muted })
      .eq('conversation_id', input.conversationId)
      /*
       * Narrower than the policy, and it has to be. `conversation_participants_update_self`
       * permits the reader's own row and `conversation_participants_update_admin`
       * permits every row of a conversation they administer — so without this, an
       * admin muting a group would mute it for the whole group. `profile_id` is
       * taken from the session, never from the form.
       */
      .eq('profile_id', user.id)
      .select('profile_id')
      .returns<{ profile_id: string }[]>()

    if (error) {
      console.error('[messages:setMuted]', error.code, error.message)
      throw error
    }

    /*
     * Zero rows is not an error in Postgres: a policy filtered the update away. It
     * is reported as a refusal here, because a switch that reports success for a
     * write that did not happen ends up showing the opposite of the database.
     */
    if (!data || data.length === 0) {
      throw new ActionError('That conversation is not yours to change.')
    }

    revalidatePath('/messages')

    return { muted: input.muted }
  })

export async function setConversationMutedAction(
  conversationId: string,
  muted: boolean,
): Promise<MuteOutcome> {
  const result = await setMuted({ conversationId, muted })
  if (result.ok) return { ok: true, muted: result.value.muted }
  return { ok: false, message: result.error }
}
