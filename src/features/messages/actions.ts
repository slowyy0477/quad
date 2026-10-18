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
 *
 * LOCAL MODE
 * ----------
 * `lib/action`'s wrapper is built around `createClient()`, which throws in local
 * mode, so each action takes its local branch before reaching it and returns the
 * same value the wrapper would have: a `FormState` for the two form actions, a
 * `MarkReadOutcome`/`MuteOutcome` for the two direct calls. Nothing is deleted from
 * the Supabase path.
 *
 * What the database enforced is written out in TypeScript, and the parts the store
 * cannot represent are refused rather than stubbed:
 *
 *   * `sender_id` is still not a form field. It is the reader's profile, resolved
 *     from the session inside the write.
 *   * `app.messages_after_insert` is applied by hand: the new message's id and
 *     instant go into the conversation's `last_message_at`/`last_message_preview`
 *     (`left(body, 140)`, in code points), and the unread count is left to be
 *     *derived* from `last_read_at` by the queries — the store has no counter to
 *     increment, and writing one would be a second source of truth.
 *   * `start_direct_conversation` keeps its idempotence: the pair of participants is
 *     the key, so opening the same chat twice returns one conversation. The pair
 *     columns do not exist locally, so the participant set stands in for them.
 *   * `mark_conversation_read` stamps `last_read_at` on the caller's own row and
 *     nothing else, because `last_read_at` is the only read-state column the store
 *     has.
 *   * `is_muted` has no column at all, so muting is refused with a sentence instead
 *     of a switch that reports a state nothing stores.
 */

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { ActionError, action, formInput, requireActiveAccount, toFormState } from '@/lib/action'
import type { FormState } from '@/lib/form-state'
import { isLocalMode } from '@/lib/mode'
import { id, mutate, now, readStore, type LocalProfile, type Tables } from '@/lib/local/db'
import { getUser } from '@/lib/supabase/server'
import {
  findMessagingTarget,
  getMessagingPermission,
} from '@/features/messages/queries'
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
// The local store
// ---------------------------------------------------------------------------

/** `id('<prefix>')` produces `<prefix>_<base36 timestamp><base36 random>`. */
const LOCAL_ID = /^[a-z]+_[a-z0-9]{1,64}$/

const NOT_SIGNED_IN = 'Please sign in to do that.'

/** The reader's profile row — messages are authored and read by `profile_id`. */
function readerProfile(db: Tables, userId: string): LocalProfile | null {
  return db.profiles.find((profile) => profile.user_id === userId) ?? null
}

function participates(db: Tables, conversationId: string, profileId: string): boolean {
  return db.conversation_participants.some(
    (participant) =>
      participant.conversation_id === conversationId && participant.profile_id === profileId,
  )
}

/**
 * `left(body, 140)` from `app.messages_after_insert`, in code points.
 *
 * `String.prototype.slice` counts UTF-16 units, so it can cut an emoji in half where
 * Postgres's `left()` would not. `Array.from` splits into code points, which is what
 * the trigger's length semantics are for text.
 */
function previewOf(body: string): string {
  return Array.from(body).slice(0, 140).join('')
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
  if (isLocalMode()) return sendMessageLocal(formData)

  const result = await sendMessage(formInput(formData))
  return toFormState(result, 'Sent.', formData)
}

/**
 * `sendMessage`, against the store.
 *
 * The validation order is the wrapper's — schema, then authentication, then the
 * write — and the refusals are the same sentences the trigger hints carry, because a
 * reader should not be able to tell which mode they are in from the wording.
 *
 * `unread_count` is deliberately not touched. In Postgres the trigger increments a
 * column; here the count is derived from `last_read_at` when it is read, so the one
 * write that matters is the conversation's last-message pair.
 */
async function sendMessageLocal(formData: FormData): Promise<FormState> {
  const values = formInput(formData)
  const conversationId = String(formData.get('conversationId') ?? '')
  const body = String(formData.get('body') ?? '').trim()

  if (!LOCAL_ID.test(conversationId)) {
    return {
      status: 'error',
      message: 'Check the fields marked below.',
      fieldErrors: { conversationId: 'That conversation could not be identified.' },
      values,
    }
  }

  if (body.length === 0) {
    return {
      status: 'error',
      message: 'Check the fields marked below.',
      fieldErrors: { body: 'Write a message first.' },
      values,
    }
  }

  if (body.length > 4000) {
    return {
      status: 'error',
      message: 'Check the fields marked below.',
      fieldErrors: { body: 'Messages are at most 4000 characters.' },
      values,
    }
  }

  const user = await getUser()
  if (!user) return { status: 'error', message: NOT_SIGNED_IN, values }

  const outcome = await mutate((db) => {
    const reader = readerProfile(db, user.id)
    if (!reader) {
      return {
        ok: false as const,
        message:
          'Your profile has not been set up yet, so that could not be saved. Finish onboarding first.',
      }
    }

    // `messages_insert_participant`: participation, and a conversation that is not the
    // reader's is indistinguishable from one that does not exist.
    if (!participates(db, conversationId, reader.id)) {
      return { ok: false as const, message: SEND_REFUSALS.not_participant ?? 'This message was not sent.' }
    }

    const conversation = db.conversations.find((candidate) => candidate.id === conversationId)
    if (!conversation) {
      return { ok: false as const, message: SEND_REFUSALS.not_participant ?? 'This message was not sent.' }
    }

    const createdAt = now()

    // The author is the session's profile. There is no field for it in the form and
    // none in this function's input.
    db.messages.push({
      id: id('msg'),
      conversation_id: conversation.id,
      author_id: reader.id,
      body,
      created_at: createdAt,
    })

    // `app.messages_after_insert`: the list's preview and its ordering key move to the
    // message that was just written.
    conversation.last_message_at = createdAt
    conversation.last_message_preview = previewOf(body)

    return { ok: true as const }
  })

  if (!outcome.ok) return { status: 'error', message: outcome.message, values }

  revalidatePath('/messages')

  return { status: 'success', message: 'Sent.' }
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
  if (isLocalMode()) return startConversationLocal(formData)

  const result = await startConversation(formInput(formData))

  // The redirect is outside the wrapper on purpose: `redirect()` signals by
  // throwing, and the wrapper's job is to turn anything thrown into a refusal, so
  // a redirect raised inside it would arrive as "that could not be saved".
  if (!result.ok) return toFormState(result, '', formData)

  redirect(`/messages?c=${result.value.conversationId}`)
}

/**
 * `start_direct_conversation`, against the store.
 *
 * Same three steps in the same order: resolve the handle, ask the readable half of
 * `app.can_message` (a courtesy that produces a better sentence than a failed
 * round trip), then open the conversation. The idempotence is the part worth
 * keeping exact — "message this person" twice must return one thread, never two —
 * and locally the participant pair is the key, because the store has no
 * `pair_low`/`pair_high` columns.
 */
async function startConversationLocal(formData: FormData): Promise<FormState> {
  const values = formInput(formData)

  const parsed = startConversationSchema.safeParse({ username: String(formData.get('username') ?? '') })
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      fieldErrors[String(issue.path[0] ?? 'form')] ??= issue.message
    }
    return { status: 'error', message: 'Check the fields marked below.', fieldErrors, values }
  }

  const user = await getUser()
  if (!user) return { status: 'error', message: NOT_SIGNED_IN, values }

  // The same lookup the Supabase path makes, through the same visibility rule.
  const target = await findMessagingTarget(parsed.data.username)
  if (!target) {
    return {
      status: 'error',
      message: 'No one here uses that handle. Check the spelling, or find them from the feed.',
      fieldErrors: { username: 'That handle is not in use.' },
      values,
    }
  }

  const permission = await getMessagingPermission(user.id, target.id)
  if (permission.state === 'refused') return { status: 'error', message: permission.reason, values }

  const opened = await mutate((db) => {
    const reader = readerProfile(db, user.id)
    if (!reader) {
      return {
        ok: false as const,
        message:
          'Your profile has not been set up yet, so that could not be saved. Finish onboarding first.',
      }
    }

    const pair = [reader.id, target.id]

    // The pair index, reproduced: a direct conversation whose participant set is
    // exactly these two people, whoever asked first and however many times.
    const existing = db.conversations.find((conversation) => {
      if (conversation.type !== 'direct') return false
      const participants = db.conversation_participants.filter(
        (participant) => participant.conversation_id === conversation.id,
      )
      if (participants.length !== pair.length) return false
      return pair.every((profileId) =>
        participants.some((participant) => participant.profile_id === profileId),
      )
    })

    if (existing) return { ok: true as const, conversationId: existing.id }

    const conversationId = id('cnv')
    db.conversations.push({
      id: conversationId,
      type: 'direct',
      title: null,
      // `conversations_before_write` nulls these on insert: nobody has written yet.
      last_message_at: null,
      last_message_preview: null,
      created_at: now(),
    })

    // Both participant rows in the same write, or the conversation is unreachable by
    // anyone, including its author — which is why this is one `mutate` and not two.
    for (const profileId of pair) {
      db.conversation_participants.push({
        id: id('par'),
        conversation_id: conversationId,
        profile_id: profileId,
        last_read_at: null,
      })
    }

    return { ok: true as const, conversationId }
  })

  if (!opened.ok) return { status: 'error', message: opened.message, values }

  revalidatePath('/messages')

  redirect(`/messages?c=${opened.conversationId}`)
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
  if (isLocalMode()) return markConversationReadLocal(conversationId)

  const result = await markRead({ conversationId })
  if (result.ok) return { ok: true, marked: true }
  return { ok: false, message: result.error }
}

/**
 * `mark_conversation_read`, against the store.
 *
 * One column, the reader's own row: `last_read_at`. There is no `unread_count` in
 * the store to reset — it is derived from this stamp when the list is read — so
 * stamping it *is* marking read, and the two facts cannot disagree because there is
 * only one of them.
 *
 * Zero rows is `42501` in Postgres (a participation row the policy does not allow),
 * and it is reported as the same refusal here rather than as success. `marked` is
 * only true for a stamp that happened.
 */
async function markConversationReadLocal(conversationId: string): Promise<MarkReadOutcome> {
  if (!LOCAL_ID.test(conversationId)) {
    return { ok: false, message: 'That conversation could not be identified.' }
  }

  const user = await getUser()
  if (!user) return { ok: false, message: NOT_SIGNED_IN }

  const marked = await mutate((db) => {
    const reader = readerProfile(db, user.id)
    if (!reader) return false

    const participant = db.conversation_participants.find(
      (candidate) =>
        candidate.conversation_id === conversationId && candidate.profile_id === reader.id,
    )
    if (!participant) return false

    participant.last_read_at = now()
    return true
  })

  if (!marked) {
    return { ok: false, message: 'That conversation is not yours, so nothing was marked read.' }
  }

  revalidatePath('/messages')

  return { ok: true, marked: true }
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
  if (isLocalMode()) {
    // `conversation_participants` in the store has `last_read_at` and nothing else.
    // There is no `is_muted` column, so there is nowhere to put this, and a no-op
    // that reported success would leave the switch showing a state nothing stores —
    // which is worse than the switch saying why it cannot move.
    return {
      ok: false,
      message:
        'Muting is not stored in local mode: the local conversation_participants row has no ' +
        'is_muted column, so nothing was changed.',
    }
  }

  const result = await setMuted({ conversationId, muted })
  if (result.ok) return { ok: true, muted: result.value.muted }
  return { ok: false, message: result.error }
}
