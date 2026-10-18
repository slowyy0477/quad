/**
 * Messaging view models.
 *
 * These live apart from `queries.ts` on purpose. `queries.ts` imports
 * 'server-only', which throws the moment it is pulled into a Client Component or
 * a jsdom test — and the thread components and their tests need these shapes. A
 * type-only import is erased before runtime, so importing from here brings in no
 * server code.
 *
 * Field names match the schema (`created_at`, `unread_count`) rather than being
 * renamed to camelCase. A half-renamed view model is harder to check against
 * SCHEMA.md than one that still speaks the table's language, and the names that
 * *are* derived (`mine`, `i_blocked`, `others`) are derived in the query, where
 * the reasoning for them sits.
 */

import type { Cursor } from '@/lib/cursor'

/** A person as the thread and the list render them. */
export type MessageAuthor = {
  id: string
  username: string
  display_name: string
  avatar_url: string | null
}

/**
 * One message as the thread renders it.
 *
 * `mine` is deliberately absent: who the reader is is a property of the request,
 * not of the message, and `buildThreadRenderPlan` adds it from `sender_id`.
 *
 * `deleted_at` is carried rather than filtered away. A soft-deleted message stays
 * visible to the conversation as a placeholder, because a thread that silently
 * rewrites itself is worse than one that says a message was withdrawn.
 */
export type ThreadMessage = {
  id: string
  sender_id: string
  body: string | null
  created_at: string
  is_edited: boolean
  deleted_at: string | null
  attachment_name: string | null
  author: MessageAuthor | null
}

/**
 * A conversation row in the list.
 *
 * `unread_count` and `last_message_preview` are read from the columns the
 * database maintains with triggers (`app.messages_after_insert`). Nothing here is
 * recomputed in the browser: a badge that says 3 because three rows happened to be
 * fetched is exactly the invented number PRODUCT.md rule 1 forbids.
 *
 * `other` is null when the counterpart's profile is not readable — `profiles` has
 * its own visibility policy and a conversation with someone whose profile you may
 * not read is a real state. The list says so rather than showing a blank name.
 */
export type ConversationSummary = {
  id: string
  type: string
  /** A group's name. A direct conversation has none: the other person is the name. */
  title: string | null
  last_message_at: string | null
  last_message_preview: string | null
  /** `last_message_at`, falling back to the conversation's own creation time. */
  last_activity_at: string
  unread_count: number
  is_muted: boolean
  last_read_at: string | null
  other: MessageAuthor | null
  /** Every other readable participant, for a group's subtitle. */
  others: MessageAuthor[]
  /**
   * True when the reader has blocked someone in this conversation.
   *
   * Only the reader's own blocks are visible (`blocks_select_own`), which is the
   * only direction this interface can know about. A block in the other direction
   * is invisible by policy, so it is not guessed at: the composer is still offered
   * and the database's refusal is shown if it fires.
   */
  i_blocked: boolean
  /**
   * True when the reader has left this conversation (`left_at` is set).
   *
   * Leaving does not delete history: the select policies use
   * `was_conversation_participant`, so the thread still renders. Nothing can be
   * written to it — `messages_insert_participant` requires `left_at is null` — so
   * the composer is replaced by an explanation rather than by a refused action.
   */
  left: boolean
}

export type ConversationPage = {
  conversations: ConversationSummary[] | null
  nextCursor: Cursor | null
  error: string | null
}

/** The header of one open thread, and the reader's own state within it. */
export type ConversationPane = {
  id: string
  type: string
  title: string | null
  other: MessageAuthor | null
  unread_count: number
  is_muted: boolean
  i_blocked: boolean
  /** True when the reader has left; see `ConversationSummary['left']`. */
  left: boolean
  /**
   * When the reader last marked this conversation read, straight from
   * `conversation_participants`. The unread divider is drawn from this and from
   * nothing else — null means the row has never been stamped, which is not the
   * same as "read everything".
   */
  last_read_at: string | null
}

export type ThreadPage = {
  messages: ThreadMessage[] | null
  /**
   * The cursor for the page *before* this one, or null at the start of the
   * conversation. The thread reads forwards, so this walks backwards in time one
   * page per request; see `listThreadMessages`.
   */
  olderCursor: Cursor | null
  /** False when the page came back short, which is the only honest end-of-list. */
  hasOlder: boolean
  error: string | null
}

/**
 * Whether a conversation with someone may be started, as far as the reader's own
 * rows can prove.
 *
 * `allowed` means "nothing the reader is allowed to see forbids this", not "the
 * database will accept it". The rule lives in `app.can_message`, which is not
 * reachable from PostgREST (the `app` schema is not exposed), and one of its
 * inputs — a block in the other direction — is not readable by the reader at all.
 * So this is a courtesy check that avoids offering an action that will be refused,
 * and the authoritative refusal is the database's, reported as a sentence when it
 * fires. Stated here rather than discovered later.
 */
export type MessagingPermission =
  | { state: 'allowed' }
  | { state: 'refused'; reason: string }

/**
 * The result of a direct (non-form) action call.
 *
 * A control that acts on one row — mute a conversation, mark a thread read — is
 * called from an event handler rather than posted as a form, so it reports back a
 * value instead of a `FormState`. `marked` and `muted` are what the database holds
 * *after* the write, which is what a control should be set from: an update that a
 * policy filtered away is not an error, it is zero rows, and reporting success for
 * it is how a switch ends up showing the opposite of the truth.
 */
export type MarkReadOutcome =
  | { ok: true; marked: boolean }
  | { ok: false; message: string }

export type MuteOutcome = { ok: true; muted: boolean } | { ok: false; message: string }
