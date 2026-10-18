import 'server-only'

/**
 * Messaging reads.
 *
 * Nothing here filters by participation, and that is the point. Every select runs
 * as the signed-in user, and four policies decide what comes back:
 *
 *   `conversations_select_participant`    app.was_conversation_participant(id)
 *   `conversation_participants_select`    app.was_conversation_participant(conversation_id)
 *   `messages_select_participant`         participation, and not hidden by moderation
 *   `blocks_select_own`                   only the reader's own blocks
 *
 * `tests/db/messaging.test.ts` proves all four by handing the attacker the real
 * conversation id and the real message id and checking that neither helps. A
 * second copy of "is this person a participant" in TypeScript would be a copy that
 * the next direct PostgREST call does not have to satisfy, which is why there
 * isn't one.
 *
 * What *is* filtered here is `deleted_at` and `moderation_status`, exactly as the
 * feed does, because those are not access-control questions: a removed message is
 * invisible to everyone, and the policy leaves it readable so moderators can
 * review it.
 *
 * ## Why the conversation list is ordered by `updated_at` and not `last_message_at`
 *
 * A chat list is read most-recent-first, and `last_message_at` is the field that
 * means that — but it is nullable (`conversations_before_write` sets it to null
 * for a conversation nobody has written into), so ordering by it would need
 * `NULLS LAST` and the cursor would have to encode "the boundary row had no
 * messages", which the `created_at|id` cursor shape cannot carry. `updated_at` is
 * NOT NULL, is set to the same instant as `last_message_at` by
 * `app.messages_after_insert` (which updates the conversation, firing
 * `conversations_set_updated_at`), and is *not* touched when the reader marks the
 * thread read — so reading a conversation does not reorder the list, which
 * ordering by `last_read_at` would have done. The activity time the interface
 * shows is still `last_message_at`, falling back to `created_at`.
 *
 * ## The one parameter that is passed in rather than read from the session
 *
 * `meId` comes from the page, which obtained it from `getUser()` (a verified
 * token, not the raw cookie). It is used for exactly one thing: choosing which of
 * the participant rows already returned by the policy is the reader's own, so that
 * `unread_count`, `is_muted` and `last_read_at` shown are theirs and not the other
 * person's. A wrong value could therefore only mislabel the reader's own view of a
 * conversation they are already a member of; it cannot widen what is read, because
 * the rows themselves arrive filtered by row level security.
 */

import { decodeCursor, type Cursor } from '@/lib/cursor'
import { createClient } from '@/lib/supabase/server'
import type {
  ConversationPage,
  ConversationPane,
  ConversationSummary,
  MessageAuthor,
  MessagingPermission,
  ThreadMessage,
  ThreadPage,
} from './types'

export const CONVERSATION_PAGE_SIZE = 20
export const THREAD_PAGE_SIZE = 30

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const CONVERSATION_SELECT = `
  id, type, title, created_at, updated_at, last_message_at, last_message_preview,
  participants:conversation_participants!conversation_participants_conversation_id_fkey (
    profile_id, role, unread_count, is_muted, last_read_at, left_at,
    profile:profiles!conversation_participants_profile_id_fkey (
      id, username, display_name, avatar_url
    )
  )
`

const MESSAGE_SELECT = `
  id, sender_id, body, created_at, is_edited, deleted_at, attachment_name,
  sender:profiles!messages_sender_id_fkey ( id, username, display_name, avatar_url )
`

type ParticipantJoin = {
  profile_id: string
  role: string
  unread_count: number
  is_muted: boolean
  last_read_at: string | null
  left_at: string | null
  profile: MessageAuthor | null
}

type ConversationJoinRow = {
  id: string
  type: string
  title: string | null
  created_at: string
  updated_at: string
  last_message_at: string | null
  last_message_preview: string | null
  participants: ParticipantJoin[] | null
}

type MessageJoinRow = {
  id: string
  sender_id: string
  body: string | null
  created_at: string
  is_edited: boolean
  deleted_at: string | null
  attachment_name: string | null
  sender: MessageAuthor | null
}

/**
 * A profile row that `profiles_select_visible` returned, or nothing.
 *
 * A conversation with someone whose profile the reader may not see is a real
 * state: `app.can_view_profile` allows a profile the reader does not own only when
 * it is `public`, active and not deleted. The list renders "A student" rather than
 * a blank or an invented name, and no link is offered to a page that would 404.
 */
function toAuthor(profile: MessageAuthor | null | undefined): MessageAuthor | null {
  if (!profile || !profile.username || !profile.display_name) return null
  return profile
}

function participantsOf(row: ConversationJoinRow): ParticipantJoin[] {
  return row.participants ?? []
}

function summarise(
  row: ConversationJoinRow,
  meId: string,
  blockedIds: ReadonlySet<string>,
): ConversationSummary {
  const participants = participantsOf(row)
  const mine = participants.find((participant) => participant.profile_id === meId)
  const others = participants.filter((participant) => participant.profile_id !== meId)
  const readable = others
    .map((participant) => toAuthor(participant.profile))
    .filter((author): author is MessageAuthor => author !== null)

  return {
    id: row.id,
    type: row.type,
    title: row.title,
    last_message_at: row.last_message_at,
    last_message_preview: row.last_message_preview,
    last_activity_at: row.last_message_at ?? row.created_at,
    unread_count: mine?.unread_count ?? 0,
    is_muted: mine?.is_muted ?? false,
    last_read_at: mine?.last_read_at ?? null,
    other: row.type === 'direct' ? (readable[0] ?? null) : null,
    others: readable,
    i_blocked: others.some((participant) => blockedIds.has(participant.profile_id)),
    left: mine?.left_at != null,
  }
}

/**
 * Which of these people the reader has blocked.
 *
 * `blocks` has no policy that reveals a block against the reader — only
 * `blocker_id = auth.uid()` passes — so this answers one direction and the
 * interface never claims to know the other. The `.in()` is a narrowing filter over
 * rows the policy has already restricted to the reader's own; it is not a second
 * copy of the policy.
 */
async function blockedAmong(
  supabase: Awaited<ReturnType<typeof createClient>>,
  profileIds: string[],
): Promise<Set<string>> {
  const unique = [...new Set(profileIds.filter((id) => UUID.test(id)))]
  if (unique.length === 0) return new Set()

  const { data, error } = await supabase
    .from('blocks')
    .select('blocked_id')
    .in('blocked_id', unique)
    .returns<{ blocked_id: string }[]>()

  if (error) {
    // A missing block list shows a conversation as sendable that is not. The
    // database refuses the write and its sentence is shown, so this degrades to
    // "you find out when you press send" rather than to a wrong claim.
    console.error('[messages:blockedAmong]', error.code, error.message)
    return new Set()
  }

  return new Set((data ?? []).map((row) => row.blocked_id))
}

/** One page of the reader's conversations, most recently active first. */
export async function listConversations({
  meId,
  limit = CONVERSATION_PAGE_SIZE,
  cursor,
}: {
  meId: string
  limit?: number
  cursor?: string | string[]
}): Promise<ConversationPage> {
  const supabase = await createClient()
  const decoded = decodeCursor(Array.isArray(cursor) ? cursor[0] : cursor)

  let query = supabase
    .from('conversations')
    .select(CONVERSATION_SELECT)
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit)

  if (decoded) {
    // Keyset, not offset: a conversation bumped to the top while the reader is
    // scrolling would otherwise push a row onto the next page that they had
    // already passed.
    query = query.or(
      `updated_at.lt.${decoded.createdAt},and(updated_at.eq.${decoded.createdAt},id.lt.${decoded.id})`,
    )
  }

  const { data, error } = await query.returns<ConversationJoinRow[]>()

  if (error) {
    console.error('[messages:listConversations]', error.code, error.message)
    return {
      conversations: null,
      nextCursor: null,
      error: 'Your conversations could not be loaded. Please try again.',
    }
  }

  const rows = data ?? []
  const blocked = await blockedAmong(
    supabase,
    rows.flatMap((row) =>
      participantsOf(row)
        .filter((participant) => participant.profile_id !== meId)
        .map((participant) => participant.profile_id),
    ),
  )

  const conversations = rows.map((row) => summarise(row, meId, blocked))
  const last = rows.at(-1)

  return {
    conversations,
    nextCursor: rows.length === limit && last ? { createdAt: last.updated_at, id: last.id } : null,
    error: null,
  }
}

/**
 * One conversation's header and the reader's own state in it.
 *
 * `null` covers both "no such conversation" and "not yours" — the policy returns
 * no rows for either, and telling them apart would confirm the existence of a
 * conversation to the person refused it. The page renders the list with a notice
 * rather than a 404, so a mismatched id is not a dead end.
 */
export async function getConversationPane(
  conversationId: string,
  meId: string,
): Promise<ConversationPane | null> {
  if (!UUID.test(conversationId)) return null

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('conversations')
    .select(CONVERSATION_SELECT)
    .eq('id', conversationId)
    .maybeSingle<ConversationJoinRow>()

  if (error) {
    console.error('[messages:getConversationPane]', error.code, error.message)
    return null
  }
  if (!data) return null

  const participants = participantsOf(data)
  const mine = participants.find((participant) => participant.profile_id === meId)
  const others = participants.filter((participant) => participant.profile_id !== meId)
  const readable = others
    .map((participant) => toAuthor(participant.profile))
    .filter((author): author is MessageAuthor => author !== null)
  const blocked = await blockedAmong(
    supabase,
    others.map((participant) => participant.profile_id),
  )

  return {
    id: data.id,
    type: data.type,
    title: data.title,
    other: data.type === 'direct' ? (readable[0] ?? null) : null,
    unread_count: mine?.unread_count ?? 0,
    is_muted: mine?.is_muted ?? false,
    i_blocked: others.some((participant) => blocked.has(participant.profile_id)),
    left: mine?.left_at != null,
    last_read_at: mine?.last_read_at ?? null,
  }
}

/**
 * One page of a conversation's messages, oldest-first for rendering.
 *
 * The thread reads forwards and paginates *backwards*: no cursor means the newest
 * `limit` messages, and a cursor means the `limit` messages immediately older than
 * the oldest one currently on screen. So each "load earlier" request shifts the
 * window one page into the past rather than appending to a growing list, which is
 * what lets the control stay a real link with a real URL (ARCHITECTURE §6) and
 * what makes the scroll position a non-issue: the link sits above the messages it
 * replaces, where the reader's viewport already is, and `LoadMore` passes
 * `scroll={false}` so the browser does not jump to the top of the document.
 *
 * The rows come back newest-first from the keyset and are reversed here, because
 * the ordering that makes the cursor total (`created_at desc, id desc`, matching
 * `messages_conversation_idx` exactly) is the opposite of the order a conversation
 * is read in.
 */
export async function listThreadMessages({
  conversationId,
  limit = THREAD_PAGE_SIZE,
  cursor,
}: {
  conversationId: string
  limit?: number
  cursor?: string | string[]
}): Promise<ThreadPage> {
  if (!UUID.test(conversationId)) {
    return { messages: null, olderCursor: null, hasOlder: false, error: 'That conversation could not be read.' }
  }

  const supabase = await createClient()
  const decoded = decodeCursor(Array.isArray(cursor) ? cursor[0] : cursor)

  let query = supabase
    .from('messages')
    .select(MESSAGE_SELECT)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit)

  if (decoded) {
    query = query.or(
      `created_at.lt.${decoded.createdAt},and(created_at.eq.${decoded.createdAt},id.lt.${decoded.id})`,
    )
  }

  const { data, error } = await query.returns<MessageJoinRow[]>()

  if (error) {
    console.error('[messages:listThreadMessages]', error.code, error.message)
    return {
      messages: null,
      olderCursor: null,
      hasOlder: false,
      error: 'This conversation could not be loaded. Please try again.',
    }
  }

  const rows = data ?? []
  const oldest = rows.at(-1)
  // A short page is the only honest end-of-thread signal: a full page means there
  // is probably more, and there is no counting query that would say so exactly
  // without reading the whole conversation.
  const hasOlder = rows.length === limit

  const messages: ThreadMessage[] = [...rows].reverse().map((row) => ({
    id: row.id,
    sender_id: row.sender_id,
    body: row.body,
    created_at: row.created_at,
    is_edited: row.is_edited,
    deleted_at: row.deleted_at,
    attachment_name: row.attachment_name,
    author: toAuthor(row.sender),
  }))

  return {
    messages,
    olderCursor: hasOlder && oldest ? { createdAt: oldest.created_at, id: oldest.id } : null,
    hasOlder,
    error: null,
  }
}

/**
 * Can this reader start a conversation with this person?
 *
 * This mirrors `app.can_message` — including its one message for every reason, so
 * a refusal cannot be used to probe someone's settings — but it is a *courtesy*,
 * not the boundary. The boundary is the function, which refuses the write with
 * `42501` / hint `messaging_not_permitted`, and that refusal is shown as a
 * sentence when it fires. Two things make the mirror incomplete by construction,
 * and both are stated rather than hidden:
 *
 *   1. `app` is not an exposed PostgREST schema, so the function cannot be called
 *      from here to ask it directly.
 *   2. A block in the *other* direction is not readable by this reader at all
 *      (`blocks_select_own`), so it cannot be checked here. When that is the only
 *      reason, this returns "allowed" and the database says no.
 *
 * When the target's profile is not readable, there is nothing to check against and
 * the answer is again "allowed": refusing on an invisible row would turn this into
 * an oracle for whether an account exists.
 */
export async function getMessagingPermission(
  meId: string,
  targetId: string,
): Promise<MessagingPermission> {
  if (!UUID.test(targetId)) return { state: 'refused', reason: 'That person could not be identified.' }
  if (targetId === meId) {
    return { state: 'refused', reason: 'You cannot start a conversation with yourself.' }
  }

  const supabase = await createClient()

  const [target, me, block, connection] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, allow_messages_from, status, university_id')
      .eq('id', targetId)
      .maybeSingle<{
        id: string
        allow_messages_from: string
        status: string
        university_id: string | null
      }>(),
    supabase
      .from('profiles')
      .select('id, university_id')
      .eq('id', meId)
      .maybeSingle<{ id: string; university_id: string | null }>(),
    supabase.from('blocks').select('blocked_id').eq('blocked_id', targetId).maybeSingle<{ blocked_id: string }>(),
    supabase
      .from('connections')
      .select('status')
      .eq('status', 'accepted')
      .or(
        `and(requester_id.eq.${meId},addressee_id.eq.${targetId}),` +
          `and(requester_id.eq.${targetId},addressee_id.eq.${meId})`,
      )
      .maybeSingle<{ status: string }>(),
  ])

  for (const [label, result] of [
    ['target', target],
    ['me', me],
    ['block', block],
    ['connection', connection],
  ] as const) {
    if (result.error) {
      console.error(`[messages:getMessagingPermission:${label}]`, result.error.code, result.error.message)
    }
  }

  if (block.data) {
    return {
      state: 'refused',
      reason: 'You have blocked this person. Unblock them from your blocked list before messaging them.',
    }
  }

  if (!target.data) return { state: 'allowed' }

  if (target.data.status !== 'active') {
    return {
      state: 'refused',
      reason: 'This account cannot receive messages at the moment.',
    }
  }

  switch (target.data.allow_messages_from) {
    case 'everyone':
      return { state: 'allowed' }
    case 'nobody':
      return { state: 'refused', reason: 'They have turned messages off.' }
    case 'university':
      if (
        me.data?.university_id &&
        target.data.university_id &&
        me.data.university_id === target.data.university_id
      ) {
        return { state: 'allowed' }
      }
      return { state: 'refused', reason: 'They only accept messages from their own university.' }
    case 'connections':
      if (connection.data) return { state: 'allowed' }
      return {
        state: 'refused',
        reason: 'They only accept messages from people they are connected to.',
      }
    default:
      // `app.can_message` treats anything it does not recognise as "no", so this
      // does too. A preference this interface does not know about must not read as
      // permission.
      return { state: 'refused', reason: 'They are not accepting messages.' }
  }
}

/** A person by handle, for the "new message" field. */
export async function findMessagingTarget(
  username: string,
): Promise<{ id: string; display_name: string; username: string; avatar_url: string | null } | null> {
  const handle = username.trim().replace(/^@/, '')
  if (handle.length < 3) return null

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url')
    .ilike('username', handle.replace(/[%_\\]/g, '\\$&'))
    .is('deleted_at', null)
    .maybeSingle<{ id: string; username: string; display_name: string; avatar_url: string | null }>()

  if (error) {
    console.error('[messages:findMessagingTarget]', error.code, error.message)
    return null
  }

  return data ?? null
}

/** The cursor type, re-exported so components need only one import for it. */
export type { Cursor }
