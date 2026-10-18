'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { isSupabaseConfigured } from '@/lib/env'
import { describeWriteError, echoValues, fieldErrorsOf, type FormState } from '@/lib/form-state'
import { createClient, getUser } from '@/lib/supabase/server'
import { isLocalMode } from '@/lib/mode'

/**
 * Connection, follow and block writes.
 *
 * What the database enforces, and therefore what these actions do not have to
 * argue about:
 *
 *   * `app.connections_before_write` sets `requester_id` to the caller and
 *     `status` to `pending` on insert. A forged requester is overwritten, so the
 *     value is never sent from a form field.
 *   * The same trigger refuses a request to someone whose
 *     `allow_connection_requests` is false, and refuses any connection between two
 *     people where a block exists in either direction.
 *   * Only the addressee may update a connection (`connections_update_addressee`),
 *     and only to `accepted` or `rejected`. That is what makes "a third party
 *     cannot accept my request" a database fact rather than a checked condition.
 *   * `app.blocks_before_insert` stamps the blocker, and
 *     `app.blocks_after_insert` severs the follows and the connection row between
 *     the two, because a block that leaves a live edge still leaks activity.
 *
 * The one thing an UPDATE here must not trust is `error === null`. RLS declining
 * an update is not an error: the statement succeeds and changes nothing. So every
 * update asks for the row back and treats an empty result as refusal.
 */

const UNAVAILABLE: FormState = {
  status: 'error',
  message: 'This deployment has no database connection, so nothing can be sent.',
}

/*
 * LOCAL MODE
 * ----------
 * The local store has no `connections`, `follows` or `blocks` table — `Tables` in
 * `src/lib/local/db.ts` is the whole store, and none of the three is in it. These
 * actions therefore do not write anything; they return a FormState that says which
 * table is missing and confirms that nothing was saved.
 *
 * Why not add the tables here: the local store's shape is decided in
 * `src/lib/local/db.ts` and mirrored by the Postgres migrations, not by a feature
 * module. A `connections` array invented in this file would be a second schema that
 * the deployment would then have to match, and a request button that appeared to
 * work against it would be claiming a graph that no page can read.
 *
 * The reads in `./queries` take the matching position: they return `'none'` and
 * empty lists with no error, so the pages' real empty states render.
 */
const LOCAL_SEND: FormState = {
  status: 'error',
  message:
    'Local mode has no connections table, so a connection request cannot be recorded. Nothing was sent.',
}

const LOCAL_RESPOND: FormState = {
  status: 'error',
  message: 'Local mode has no connections table, so there is no request to answer. Nothing was changed.',
}

const LOCAL_REMOVE: FormState = {
  status: 'error',
  message: 'Local mode has no connections table, so there is no connection or request to remove.',
}

const LOCAL_FOLLOW: FormState = {
  status: 'error',
  message: 'Local mode has no follows table, so following cannot be recorded. Nothing was changed.',
}

const LOCAL_BLOCK: FormState = {
  status: 'error',
  message: 'Local mode has no blocks table, so a block cannot be recorded. Nothing was changed.',
}

const LOCAL_UNBLOCK: FormState = {
  status: 'error',
  message: 'Local mode has no blocks table, so there is no block to remove.',
}

const targetSchema = z.object({
  profileId: z.string().uuid('That person could not be identified'),
  /** Sent so the cache for their profile page can be revalidated. Never trusted as an id. */
  username: z.string().trim().max(30).optional(),
})

function revalidatePair(username?: string) {
  revalidatePath('/connections')
  revalidatePath('/me')
  if (username) revalidatePath(`/u/${username}`)
}

/**
 * Turns the triggers' hints into sentences.
 *
 * The `using hint = …` clauses in 0005 exist precisely so this can distinguish the
 * refusals without matching on message text, which is not a stable interface. The
 * raw message goes to the server log and never to the browser.
 */
function describeConnectionError(
  error: { code?: string; message?: string; hint?: string | null },
  context: string,
  overrides: Partial<Record<string, string>> = {},
): FormState {
  if (error.code === '42501') {
    console.error(`[connections:${context}]`, error.code, error.hint ?? '')
    return {
      status: 'error',
      message: (error.hint ?? '').includes('requests_disabled')
        ? 'That person is not accepting connection requests.'
        : (error.hint ?? '').includes('requests')
          ? 'That person is not accepting connection requests.'
          : 'That connection is not possible.',
    }
  }

  return describeWriteError(error, `connections:${context}`, overrides)
}

// -----------------------------------------------------------------------------
// Requests
// -----------------------------------------------------------------------------

/**
 * Ask someone to connect.
 *
 * A rejected row between the same two people is deleted first, because the
 * uniqueness constraint in 0005 is on the ordered pair and not on the status: one
 * row per pair, whatever happened to it. Without that step, asking again after a
 * decline would fail on a duplicate key the reader cannot see and would have no
 * way to act on. Either party may delete a row they are part of
 * (`connections_delete_party`), so this is permitted to both sides of a decline.
 */
export async function sendConnectionRequestAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (isLocalMode()) return LOCAL_SEND
  if (!isSupabaseConfigured()) return UNAVAILABLE

  const parsed = targetSchema.safeParse({
    profileId: String(formData.get('profileId') ?? ''),
    username: String(formData.get('username') ?? ''),
  })
  if (!parsed.success) return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error) }

  const user = await getUser()
  if (!user) redirect('/login?next=/connections')

  if (parsed.data.profileId === user.id) {
    return { status: 'error', message: 'You cannot connect with yourself.' }
  }

  const message = String(formData.get('message') ?? '').trim().slice(0, 500)
  const supabase = await createClient()

  const { error: clearError } = await supabase
    .from('connections')
    .delete()
    .eq('status', 'rejected')
    .or(
      `and(requester_id.eq.${user.id},addressee_id.eq.${parsed.data.profileId}),and(requester_id.eq.${parsed.data.profileId},addressee_id.eq.${user.id})`,
    )

  if (clearError) return describeConnectionError(clearError, 'request:clear')

  const { error } = await supabase.from('connections').insert({
    // requester_id is overwritten with the session user by the trigger. It is sent
    // because the column is NOT NULL and the insert policy reads it; it is never
    // taken from a hidden field.
    requester_id: user.id,
    addressee_id: parsed.data.profileId,
    message: message || null,
  })

  if (error) {
    return describeConnectionError(error, 'request', {
      '23505': 'You have already asked them. They have not answered yet.',
      '23503': 'That person could not be found.',
    })
  }

  revalidatePair(parsed.data.username)
  return { status: 'success', message: 'Request sent.' }
}

/** Answer a request. Only the addressee can, and only to accepted or rejected. */
async function respond(
  formData: FormData,
  status: 'accepted' | 'rejected',
): Promise<FormState> {
  if (isLocalMode()) return LOCAL_RESPOND
  if (!isSupabaseConfigured()) return UNAVAILABLE

  const id = String(formData.get('connectionId') ?? '')
  if (!z.string().uuid().safeParse(id).success) {
    return { status: 'error', message: 'That request could not be identified.' }
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/connections')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('connections')
    .update({ status })
    .eq('id', id)
    .select('id')
    .maybeSingle<{ id: string }>()

  if (error) return describeConnectionError(error, `respond:${status}`)

  // Zero rows means the policy filtered the row out — this is not the reader's
  // request to answer, or someone has already handled it.
  if (!data) {
    return { status: 'error', message: 'That request is not yours to answer, or it has already been handled.' }
  }

  revalidatePair(String(formData.get('username') ?? ''))
  return { status: 'success', message: status === 'accepted' ? 'Connected.' : 'Request declined.' }
}

export async function acceptConnectionAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  return respond(formData, 'accepted')
}

export async function declineConnectionAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  return respond(formData, 'rejected')
}

/**
 * Withdraw a request, or remove a connection.
 *
 * One statement covers both, because the policy does: either party may sever the
 * row. What the reader is told differs, so the caller says which it was doing.
 */
export async function removeConnectionAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (isLocalMode()) return LOCAL_REMOVE
  if (!isSupabaseConfigured()) return UNAVAILABLE

  const id = String(formData.get('connectionId') ?? '')
  const wasConnected = String(formData.get('wasConnected') ?? '') === 'true'

  if (!z.string().uuid().safeParse(id).success) {
    return { status: 'error', message: 'That could not be identified.' }
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/connections')

  const supabase = await createClient()
  const { data, error } = await supabase.from('connections').delete().eq('id', id).select('id')

  if (error) return describeConnectionError(error, 'remove')

  if (!data || data.length === 0) {
    return { status: 'error', message: 'That was already gone.' }
  }

  revalidatePair(String(formData.get('username') ?? ''))
  return {
    status: 'success',
    message: wasConnected ? 'Connection removed.' : 'Request withdrawn.',
  }
}

// -----------------------------------------------------------------------------
// Follows
// -----------------------------------------------------------------------------

/**
 * Follow, or unfollow. One row per direction, no consent, no notification.
 *
 * The duplicate case is treated as success rather than as an error: the primary
 * key is (follower_id, following_id), so a second click is a no-op the database
 * refuses. Reporting that as a failure would make a working button look broken.
 */
export async function setFollowAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (isLocalMode()) return LOCAL_FOLLOW
  if (!isSupabaseConfigured()) return UNAVAILABLE

  const parsed = targetSchema.safeParse({
    profileId: String(formData.get('profileId') ?? ''),
    username: String(formData.get('username') ?? ''),
  })
  if (!parsed.success) return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error) }

  const follow = String(formData.get('follow') ?? '') === 'true'

  const user = await getUser()
  if (!user) redirect('/login?next=/connections')

  if (parsed.data.profileId === user.id) {
    return { status: 'error', message: 'You cannot follow yourself.' }
  }

  const supabase = await createClient()

  if (follow) {
    const { error } = await supabase
      .from('follows')
      .insert({ follower_id: user.id, following_id: parsed.data.profileId })

    // 23505 is the primary key doing its job on a double-click.
    if (error && error.code !== '23505') {
      return describeWriteError(error, 'connections:follow', {
        '23503': 'That person could not be found.',
        '42501': 'You are not allowed to follow that person.',
      })
    }
  } else {
    const { error } = await supabase
      .from('follows')
      .delete()
      .eq('follower_id', user.id)
      .eq('following_id', parsed.data.profileId)

    if (error) return describeWriteError(error, 'connections:unfollow')
  }

  revalidatePair(parsed.data.username)
  return { status: 'success', message: follow ? 'Following.' : 'Unfollowed.' }
}

// -----------------------------------------------------------------------------
// Blocks
// -----------------------------------------------------------------------------

const blockSchema = z.object({
  profileId: z.string().uuid('That person could not be identified'),
  username: z.string().trim().max(30).optional(),
  reason: z
    .string()
    .trim()
    .max(500, 'Use at most 500 characters')
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
})

/**
 * Block someone.
 *
 * The consequence is stated in the dialog that leads here, because it is not
 * obvious and it is not reversible by the other person: their profile stops
 * resolving for the reader and the reader's stops resolving for them, the
 * connection and any follow between them are deleted, and they are not told.
 *
 * `reason` is stored on the row and is readable only by the blocker — the
 * `blocks_select_own` policy — so it is a note to self rather than a message.
 */
export async function blockAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (isLocalMode()) return LOCAL_BLOCK
  if (!isSupabaseConfigured()) return UNAVAILABLE

  const parsed = blockSchema.safeParse({
    profileId: String(formData.get('profileId') ?? ''),
    username: String(formData.get('username') ?? ''),
    reason: String(formData.get('reason') ?? ''),
  })
  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error), values: echoValues(formData) }
  }

  const user = await getUser()
  if (!user) redirect('/login?next=/connections')

  if (parsed.data.profileId === user.id) {
    return { status: 'error', message: 'You cannot block yourself.' }
  }

  const supabase = await createClient()
  const { error } = await supabase.from('blocks').insert({
    // Stamped by the trigger from the session; sent because the column is NOT NULL
    // and the insert policy reads it.
    blocker_id: user.id,
    blocked_id: parsed.data.profileId,
    reason: parsed.data.reason ?? null,
  })

  if (error) {
    if (error.code === '23505') {
      revalidatePair(parsed.data.username)
      return { status: 'success', message: 'Blocked.' }
    }
    return describeWriteError(error, 'connections:block', {
      '23503': 'That person could not be found.',
    })
  }

  // The directory, the feed and the profile all change shape for this reader: the
  // other person drops out of every list built from a profile row.
  revalidatePath('/universities')
  revalidatePath('/feed')
  revalidatePair(parsed.data.username)

  return { status: 'success', message: 'Blocked.' }
}

/** The block is one row, so undoing it is one row. Everything else recovers from RLS. */
export async function unblockAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (isLocalMode()) return LOCAL_UNBLOCK
  if (!isSupabaseConfigured()) return UNAVAILABLE

  const parsed = targetSchema.safeParse({
    profileId: String(formData.get('profileId') ?? ''),
    username: String(formData.get('username') ?? ''),
  })
  if (!parsed.success) return { status: 'error', fieldErrors: fieldErrorsOf(parsed.error) }

  const user = await getUser()
  if (!user) redirect('/login?next=/connections')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('blocks')
    .delete()
    .eq('blocked_id', parsed.data.profileId)
    .select('blocked_id')

  if (error) return describeWriteError(error, 'connections:unblock')

  if (!data || data.length === 0) {
    return { status: 'error', message: 'That block was already removed.' }
  }

  revalidatePath('/universities')
  revalidatePath('/feed')
  revalidatePair(parsed.data.username)

  // Said plainly because it is the part people get wrong: a follow or connection
  // that the block severed is not restored by unblocking.
  return {
    status: 'success',
    message: 'Unblocked. A connection or follow the block removed is not restored.',
  }
}
