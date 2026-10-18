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
 *
 * ## LOCAL MODE
 *
 * The site is running against `data/local.json` (`@/lib/local/db`), where there is
 * no policy engine, so the four policies above are written out in TypeScript and
 * applied before anything reaches a shape. That is a weaker guarantee than RLS and
 * is stated as such in docs/plan/LOCAL-MODE.md — the point here is to reproduce the
 * *rule*, not to claim the *enforcement*:
 *
 *   conversations                → the reader has a `conversation_participants` row
 *   conversation_participants    → rows of a conversation the reader participates in
 *   messages                     → rows of a conversation the reader participates in
 *   blocks                       → no `blocks` table exists locally, so nobody has
 *                                  blocked anybody and `i_blocked` is false rather
 *                                  than guessed at
 *
 * Two things the store does not have, and what is done instead of inventing them:
 *
 *   * `updated_at` and `unread_count`. There is no `updated_at` column, so the list
 *     is ordered by `last_message_at ?? created_at` — the same instant
 *     `app.messages_after_insert` puts in both columns — and the cursor carries that
 *     activity time. `unread_count` is not stored either: it is *derived* from
 *     `conversation_participants.last_read_at`, the column that does exist, by
 *     counting the messages in the conversation that are newer than it and were not
 *     written by the reader — which is precisely what the trigger increments and
 *     `mark_conversation_read` resets.
 *   * `is_muted` and `left_at`. Neither column exists locally, so both are reported
 *     as the state of a conversation nobody has muted or left, and `setMuted` in
 *     `actions.ts` refuses rather than writing a flag with nowhere to live.
 *
 * Local ids are `cnv_…`/`msg_…` rather than uuids, so every id guard in this file
 * accepts the shape the mode it is in actually produces, and the cursor decoder
 * relaxes `@/lib/cursor`'s uuid check for the store only — the encoding is still
 * that module's, and a cursor with an unparseable timestamp is still treated as
 * absent.
 */

import { decodeCursor, type Cursor } from '@/lib/cursor'
import { isLocalMode } from '@/lib/mode'
import { readStore, type LocalConversation, type LocalProfile, type Tables } from '@/lib/local/db'
import { createClient, getUser } from '@/lib/supabase/server'
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

/**
 * The shape a local id has: `id('<prefix>')` produces `<prefix>_<base36 timestamp>`.
 *
 * Used only inside local branches, and only where the uuid check stands: a value
 * that is not shaped like an id cannot be one, which is the local equivalent of the
 * uuid guard keeping a hand-edited value away from the data layer.
 */
const LOCAL_ID = /^[a-z]+_[a-z0-9]{1,64}$/

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

// ---------------------------------------------------------------------------
// The local store
// ---------------------------------------------------------------------------
//
// Everything below turns `data/local.json` into the same `ConversationJoinRow` /
// `MessageJoinRow` shapes the Supabase path gets from PostgREST, so `summarise` and
// the message mapper are shared by both modes and cannot drift. The joins the
// database does with foreign keys become `find`/`filter` over the arrays; the
// volumes are one person's development data.

/** The reader's profile row. Messaging is addressed by `profile_id`, not by user id. */
function readerProfile(db: Tables, userId: string): LocalProfile | null {
  return db.profiles.find((profile) => profile.user_id === userId) ?? null
}

/** The embedded `profiles` row, or null when it is not readable (`profiles` has its own policy). */
function authorOf(db: Tables, profileId: string): MessageAuthor | null {
  const profile = db.profiles.find((candidate) => candidate.id === profileId)
  if (!profile) return null
  return {
    id: profile.id,
    username: profile.username,
    display_name: profile.display_name,
    avatar_url: profile.avatar_url,
  }
}

/** `conversations.updated_at` does not exist locally: activity is the same instant. */
function activityOf(conversation: { last_message_at: string | null; created_at: string }): string {
  return conversation.last_message_at ?? conversation.created_at
}

/** `app.was_conversation_participant` without the `left_at` half, which has no column here. */
function participates(db: Tables, conversationId: string, profileId: string): boolean {
  return db.conversation_participants.some(
    (participant) =>
      participant.conversation_id === conversationId && participant.profile_id === profileId,
  )
}

/**
 * The reader's unread count in one conversation, derived rather than stored.
 *
 * This is `app.messages_after_insert` + `mark_conversation_read` reconstructed from
 * `last_read_at`: every message newer than the stamp, written by someone else. A
 * null stamp means the row has never been read, which is every message. The
 * reader's own messages are excluded because the trigger excludes the sender, for
 * the same reason — you have read what you wrote.
 */
function unreadOf(
  db: Tables,
  participant: { conversation_id: string; profile_id: string; last_read_at: string | null },
): number {
  return db.messages.filter(
    (message) =>
      message.conversation_id === participant.conversation_id &&
      message.author_id !== participant.profile_id &&
      (participant.last_read_at === null || message.created_at > participant.last_read_at),
  ).length
}

/** The reader's participant rows, as the embed returns them. */
function participantJoins(db: Tables, conversationId: string): ParticipantJoin[] {
  return db.conversation_participants
    .filter((participant) => participant.conversation_id === conversationId)
    .map((participant) => ({
      profile_id: participant.profile_id,
      // No `role` column: every local participant is what the seed writes, 'member'.
      role: 'member',
      unread_count: unreadOf(db, participant),
      // No `is_muted` column. False is what an unmuted row reads as; it is not a claim
      // that muting works locally — `setConversationMutedAction` refuses for that reason.
      is_muted: false,
      last_read_at: participant.last_read_at,
      // No `left_at` column: nobody has left a conversation in the store.
      left_at: null,
      profile: authorOf(db, participant.profile_id),
    }))
}

function conversationRow(db: Tables, conversation: LocalConversation): ConversationJoinRow {
  return {
    id: conversation.id,
    type: conversation.type,
    title: conversation.title,
    created_at: conversation.created_at,
    // The shape has `updated_at` and the store does not; `last_message_at ?? created_at`
    // is what the Supabase path would have in it (the trigger sets both together).
    updated_at: activityOf(conversation),
    last_message_at: conversation.last_message_at,
    last_message_preview: conversation.last_message_preview,
    participants: participantJoins(db, conversation.id),
  }
}

/** `activity desc, id desc` — the order the Supabase path gets from `updated_at, id`. */
function compareActivity(a: ConversationJoinRow, b: ConversationJoinRow): number {
  const left = activityOf(a)
  const right = activityOf(b)
  if (left !== right) return left < right ? 1 : -1
  if (a.id === b.id) return 0
  return a.id < b.id ? 1 : -1
}

/** `created_at desc, id desc` — `messages_conversation_idx`, reproduced exactly. */
function compareMessage(a: { created_at: string; id: string }, b: { created_at: string; id: string }) {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
  if (a.id === b.id) return 0
  return a.id < b.id ? 1 : -1
}

/**
 * A cursor decoded without the uuid check, for the store.
 *
 * `decodeCursor` insists the id half is a uuid because in Supabase mode every id is
 * one. Local ids are `cnv_…`, so a cursor this page encoded would decode to `null`
 * and every "load more" would return page one again — an infinite list rather than
 * a bad one. The encoding stays `@/lib/cursor`'s (the component still calls
 * `encodeCursor`); only the validity check is relaxed, and only to the shape the
 * store's own ids have. A cursor with a bad timestamp is still treated as absent,
 * which shows the first page: a better answer to a truncated URL than an error.
 */
function decodeStoreCursor(raw: string | string[] | undefined): Cursor | null {
  const value = Array.isArray(raw) ? raw[0] : raw

  const strict = decodeCursor(value)
  if (strict) return strict
  if (!value) return null

  let decoded: string
  try {
    decoded = Buffer.from(value, 'base64url').toString('utf8')
  } catch {
    return null
  }

  const separator = decoded.lastIndexOf('|')
  if (separator <= 0) return null

  const createdAt = decoded.slice(0, separator)
  const id = decoded.slice(separator + 1)

  if (!LOCAL_ID.test(id)) return null
  if (Number.isNaN(Date.parse(createdAt))) return null

  return { createdAt, id }
}

/**
 * `app.can_view_profile`, to the extent `findMessagingTarget` needs it.
 *
 * The Supabase lookup goes through `profiles_select_visible`, so a profile the
 * reader may not see comes back as no row at all. The store has the same visibility
 * values and no policy, so the readable half is written out: public, or same
 * university, or the reader's own. `connections` and `private` are readable by
 * nobody but their owner here, because the store has no connections table — which
 * is the honest state, not a copy of somebody else's rule.
 */
function readableProfile(reader: LocalProfile | null, target: LocalProfile): boolean {
  if (reader && reader.id === target.id) return true
  if (target.visibility === 'public') return true
  if (target.visibility === 'university') {
    return Boolean(reader?.university_id) && reader?.university_id === target.university_id
  }
  return false
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
  if (isLocalMode()) {
    const db = await readStore()
    const reader = readerProfile(db, meId)
    if (!reader) return { conversations: [], nextCursor: null, error: null }

    const decoded = decodeStoreCursor(cursor)

    // `conversations_select_participant`: participation is the only key, so the rows
    // are narrowed to the reader's own before anything else happens to them.
    const rows = db.conversations
      .filter((conversation) => participates(db, conversation.id, reader.id))
      .map((conversation) => conversationRow(db, conversation))
      .filter((row) => {
        if (!decoded) return true
        const activity = activityOf(row)
        return (
          activity < decoded.createdAt ||
          (activity === decoded.createdAt && row.id < decoded.id)
        )
      })
      .sort(compareActivity)
      .slice(0, limit)

    const conversations = rows.map((row) => summarise(row, reader.id, new Set<string>()))
    const last = rows.at(-1)

    return {
      conversations,
      // The cursor walks the ordering above, which is why it carries activity and not
      // `created_at`: a conversation bumped to the top mid-scroll must not reappear
      // on the next page.
      nextCursor:
        rows.length === limit && last ? { createdAt: activityOf(last), id: last.id } : null,
      error: null,
    }
  }

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
  if (isLocalMode()) {
    if (!LOCAL_ID.test(conversationId)) return null

    const db = await readStore()
    const reader = readerProfile(db, meId)
    if (!reader) return null

    // `conversations_select_participant` again: a conversation that is not the
    // reader's is the same answer as one that does not exist, which is why this is
    // `null` and not a refusal.
    const conversation = db.conversations.find((candidate) => candidate.id === conversationId)
    if (!conversation || !participates(db, conversation.id, reader.id)) return null

    const participants = participantJoins(db, conversation.id)
    const mine = participants.find((participant) => participant.profile_id === reader.id)
    const others = participants.filter((participant) => participant.profile_id !== reader.id)
    const readable = others
      .map((participant) => toAuthor(participant.profile))
      .filter((author): author is MessageAuthor => author !== null)

    return {
      id: conversation.id,
      type: conversation.type,
      title: conversation.title,
      other: conversation.type === 'direct' ? (readable[0] ?? null) : null,
      unread_count: mine?.unread_count ?? 0,
      is_muted: mine?.is_muted ?? false,
      // No `blocks` table: nothing to have blocked.
      i_blocked: false,
      left: mine?.left_at != null,
      last_read_at: mine?.last_read_at ?? null,
    }
  }

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
  if (isLocalMode()) {
    if (!LOCAL_ID.test(conversationId)) {
      return { messages: null, olderCursor: null, hasOlder: false, error: 'That conversation could not be read.' }
    }

    // `messages_select_participant` is a policy in Postgres, and the page never
    // checks it: this signature has no reader in it, because in Supabase mode the
    // session is the filter. Locally the session has to be read for the same reason,
    // so the participation rule is applied here and nowhere else.
    const user = await getUser()
    const db = await readStore()
    const reader = user ? readerProfile(db, user.id) : null
    if (!reader || !participates(db, conversationId, reader.id)) {
      return { messages: null, olderCursor: null, hasOlder: false, error: 'That conversation could not be read.' }
    }

    const decoded = decodeStoreCursor(cursor)

    const rows = db.messages
      .filter((message) => message.conversation_id === conversationId)
      .filter(
        (message) =>
          !decoded ||
          message.created_at < decoded.createdAt ||
          (message.created_at === decoded.createdAt && message.id < decoded.id),
      )
      .sort(compareMessage)
      .slice(0, limit)

    const oldest = rows.at(-1)
    const hasOlder = rows.length === limit

    const messages: ThreadMessage[] = [...rows].reverse().map((row) => ({
      id: row.id,
      sender_id: row.author_id,
      body: row.body,
      created_at: row.created_at,
      // No `is_edited`, `deleted_at` or attachment columns locally: a message is what
      // was written and nothing has been withdrawn.
      is_edited: false,
      deleted_at: null,
      attachment_name: null,
      author: authorOf(db, row.author_id),
    }))

    return {
      messages,
      olderCursor: hasOlder && oldest ? { createdAt: oldest.created_at, id: oldest.id } : null,
      hasOlder,
      error: null,
    }
  }

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
  if (isLocalMode()) {
    if (!LOCAL_ID.test(targetId)) return { state: 'refused', reason: 'That person could not be identified.' }

    const db = await readStore()
    const me = readerProfile(db, meId)
    const target = db.profiles.find((candidate) => candidate.id === targetId)

    if (targetId === meId || (me && target && me.id === target.id)) {
      return { state: 'refused', reason: 'You cannot start a conversation with yourself.' }
    }

    // The mirror of `app.can_message` is only as good as the rows it can see. A block
    // is stored in `blocks`, which the store does not have, so no block is checked
    // and none can be claimed — the same shape of gap the Supabase version documents
    // for a block in the other direction.
    if (!target) return { state: 'allowed' }

    // `profiles` has no `status` column locally: every account in the store is active,
    // which is what the seed writes.
    switch (target.allow_messages_from ?? 'everyone') {
      case 'everyone':
        return { state: 'allowed' }
      case 'nobody':
        return { state: 'refused', reason: 'They have turned messages off.' }
      case 'university':
        if (
          me?.university_id &&
          target.university_id &&
          me.university_id === target.university_id
        ) {
          return { state: 'allowed' }
        }
        return { state: 'refused', reason: 'They only accept messages from their own university.' }
      case 'connections':
        // No `connections` table exists locally, so nobody is connected to anybody and
        // this answer is true rather than convenient.
        return {
          state: 'refused',
          reason: 'They only accept messages from people they are connected to.',
        }
      default:
        return { state: 'refused', reason: 'They are not accepting messages.' }
    }
  }

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

  if (isLocalMode()) {
    const db = await readStore()
    const user = await getUser()
    const reader = user ? readerProfile(db, user.id) : null

    const found = db.profiles.find(
      (profile) => profile.username.toLowerCase() === handle.toLowerCase(),
    )
    // `profiles_select_visible` decides what this lookup can return in Supabase mode,
    // so a profile the reader may not read is "no such handle" here too — not a
    // different sentence that would confirm the account exists.
    if (!found || !readableProfile(reader, found)) return null

    return {
      id: found.id,
      username: found.username,
      display_name: found.display_name,
      avatar_url: found.avatar_url,
    }
  }

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

/**
 * Every unread message the reader has, across conversations.
 *
 * `public.total_unread_messages()` in one statement in Postgres, and the same
 * question here: the sum of the reader's own unread counts, excluding conversations
 * they have muted (which the function does) and conversations they have left (which
 * the store cannot represent). Locally the sum is derived from `last_read_at` the
 * same way each row's count is, so a badge and the list cannot disagree.
 *
 * The header renders `unreadNotifications` today and has no message badge; this is
 * the honest source for one, kept beside the read that produces the per-row numbers
 * rather than in a layout that would have to re-derive them.
 *
 * A missing badge is a cosmetic failure, so a failed rpc is logged and reported as
 * zero rather than thrown into a page render.
 */
export async function getTotalUnreadMessages(): Promise<number> {
  if (isLocalMode()) {
    const user = await getUser()
    if (!user) return 0

    const db = await readStore()
    const reader = readerProfile(db, user.id)
    if (!reader) return 0

    return db.conversation_participants
      .filter((participant) => participant.profile_id === reader.id)
      .reduce((total, participant) => total + unreadOf(db, participant), 0)
  }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('total_unread_messages')

  if (error) {
    console.error('[messages:totalUnread]', error.code, error.message)
    return 0
  }

  return typeof data === 'number' ? data : 0
}

/** The cursor type, re-exported so components need only one import for it. */
export type { Cursor }