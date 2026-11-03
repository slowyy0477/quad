import 'server-only'

import { unstable_rethrow } from 'next/navigation'
import { createClient, getUser } from '@/lib/supabase/server'
import { decodeCursor, type Cursor } from '@/lib/cursor'
import { isLocalMode } from '@/lib/mode'
import { readStore, type LocalNotification, type LocalProfile, type Tables } from '@/lib/local/db'
import { emptyTargetIndex, type TargetIndex } from '@/features/notifications/plan'
import { blockedPair, canReadProfile, canReadContent, localActor, contentActive } from '@/lib/local/access'
import { localCanViewPost } from '@/features/feed/queries'
import {
  canReadConversationActivityLocal,
  canReadConversationHistoryLocal,
} from '@/features/messages/local-access'

/**
 * Notification reads.
 *
 * The writes are not here and must not be: notifications are created in the database by
 * triggers through `app.create_notification`, de-duplicated by a unique constraint with
 * `nulls not distinct`. Local message activity is emitted within its accepted-send
 * transaction, not here. The reader's job is to display it truthfully and count it once.
 *
 * The unread count is a real `count` query rather than `rows.length` of a limited page.
 * A badge that says "9" because that is how many fitted in the fetch is the exact kind of
 * invented number PRODUCT.md rule 1 forbids. In local mode the equivalent is a count over
 * every row addressed to the reader — the whole table, not a page — with the same promise.
 *
 * LOCAL MODE
 * ----------
 * Notifications are addressed to a `profile_id`, not to a user id, so every local branch
 * starts by resolving the reader's profile. `notifications_recipient` in Postgres decides
 * what is visible; here the filter is written out: a row whose `recipient_id` is not the
 * reader's profile is dropped before it reaches the shape. The `actor` embed becomes a
 * lookup in `db.profiles`, and a missing actor profile is `null`, which is exactly what
 * the left join produced.
 */

export type NotificationRow = {
  id: string
  type: string
  body: string | null
  is_read: boolean
  created_at: string
  post_id: string | null
  comment_id: string | null
  project_id: string | null
  idea_id: string | null
  event_id: string | null
  opportunity_id: string | null
  conversation_id: string | null
  actor: {
    id: string
    username: string
    display_name: string
    avatar_url: string | null
  } | null
}

const NOTIFICATION_SELECT = `
  id, type, body, is_read, created_at,
  post_id, comment_id, project_id, idea_id, event_id, opportunity_id, conversation_id,
  actor:profiles!notifications_actor_id_fkey ( id, username, display_name, avatar_url )
`

function notificationVisibleLocal(row: LocalNotification, db: Tables, viewer: LocalProfile | null) {
  if (!viewer || row.recipient_id !== viewer.id || blockedPair(db, viewer.id, row.actor_id)) return false
  return row.type !== 'message' || Boolean(row.conversation_id &&
    canReadConversationActivityLocal(db, row.conversation_id, row.created_at, viewer))
}

/** One store notification, with its actor resolved the way the embed resolves it. */
function toNotificationRow(row: LocalNotification, db: Tables): NotificationRow {
  const actor = row.actor_id ? (db.profiles.find((profile) => profile.id === row.actor_id) ?? null) : null
  const viewer = db.profiles.find(profile => profile.id === row.recipient_id) ?? null

  return {
    id: row.id,
    type: row.type,
    // Legacy activity rows may contain text. Never serialize a private message
    // body through notifications; the authorized thread is its only read path.
    body: row.type === 'message' ? null : row.body,
    is_read: row.is_read,
    created_at: row.created_at,
    post_id: row.post_id,
    comment_id: row.comment_id,
    project_id: row.project_id,
    idea_id: row.idea_id,
    event_id: row.event_id,
    opportunity_id: row.opportunity_id,
    conversation_id: row.conversation_id,
    actor: actor && canReadProfile(db, actor, viewer)
      ? {
          id: actor.id,
          username: actor.username,
          display_name: actor.display_name,
          avatar_url: actor.avatar_url,
        }
      : null,
  }
}

/**
 * The page cursor, decoded without the uuid check.
 *
 * `decodeCursor` from `@/lib/cursor` deliberately insists that the id half is a uuid,
 * because in Supabase mode every id is one. Local ids are not — they are `ntf_…` — so a
 * cursor this page encoded would come back as `null` and every "Load more" would return
 * page one again, for ever, with a fresh cursor: an infinite list rather than a bad one.
 *
 * The encoding is `@/lib/cursor`'s and is not re-implemented (the page still calls
 * `encodeCursor`); only the validity check is relaxed, and only for the store, whose ids
 * are opaque strings. A cursor that fails the timestamp check is still treated as absent,
 * which shows the first page — a better answer to a truncated URL than an error page.
 */
function decodeLocalCursor(raw: string | string[] | undefined): Cursor | null {
  const value = Array.isArray(raw) ? raw[0] : raw
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

  if (!id) return null
  if (Number.isNaN(Date.parse(createdAt))) return null

  return { createdAt, id }
}

/** Null is a failed/unknown count, never an invented zero unread badge. */
export async function getUnreadNotificationCount(): Promise<number | null> {
  try {
    return await readUnreadNotificationCount()
  } catch (error) {
    unstable_rethrow(error)
    return null
  }
}

async function readUnreadNotificationCount(): Promise<number | null> {
  if (isLocalMode()) {
    const user = await getUser()
    if (!user) return 0

    const db = await readStore()
    const profile = localActor(db, user.id)
    if (!profile) return 0

    // Every unread row addressed to this profile — not the first page of them.
    return db.notifications.filter(row => !row.is_read && notificationVisibleLocal(row, db, profile)).length
  }

  const supabase = await createClient()

  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('is_read', false)

  return !error && typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
    ? count : null
}

export async function getNotifications({
  limit = 30,
  cursor,
}: { limit?: number; cursor?: string | string[] } = {}): Promise<{
  notifications: NotificationRow[] | null
  nextCursor: Cursor | null
  error: string | null
}> {
  try {
    const size = Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.trunc(limit))) : 30
    return await readNotifications({ limit: size, cursor })
  } catch (error) {
    unstable_rethrow(error)
    return { notifications: null, nextCursor: null, error: 'Your notifications could not be loaded.' }
  }
}

async function readNotifications({
  limit,
  cursor,
}: { limit: number; cursor?: string | string[] }): Promise<{
  notifications: NotificationRow[] | null
  nextCursor: Cursor | null
  error: string | null
}> {
  if (isLocalMode()) {
    const user = await getUser()
    if (!user) return { notifications: [], nextCursor: null, error: null }

    const db = await readStore()
    const profile = localActor(db, user.id)
    if (!profile) return { notifications: [], nextCursor: null, error: null }

    const decoded = decodeLocalCursor(cursor)

    const rows = db.notifications
      .filter(row => notificationVisibleLocal(row, db, profile))
      // Keyset, not offset: the page boundary has to hold while rows are being written.
      // Same predicate as the `or` in the Supabase path — strictly older, or the same
      // instant with a smaller id.
      .filter(
        (row) =>
          !decoded ||
          row.created_at < decoded.createdAt ||
          (row.created_at === decoded.createdAt && row.id < decoded.id),
      )
      .sort(compareNewestFirst)
      .slice(0, limit)
      .map((row) => toNotificationRow(row, db))

    const last = rows.at(-1)

    return {
      notifications: rows,
      nextCursor:
        rows.length === limit && last ? { createdAt: last.created_at, id: last.id } : null,
      error: null,
    }
  }

  const supabase = await createClient()
  const decoded = decodeCursor(Array.isArray(cursor) ? cursor[0] : cursor)

  let query = supabase
    .from('notifications')
    .select(NOTIFICATION_SELECT)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit)

  if (decoded) {
    // Keyset, not offset: the page boundary has to hold while rows are being written.
    query = query.or(
      `created_at.lt.${decoded.createdAt},and(created_at.eq.${decoded.createdAt},id.lt.${decoded.id})`,
    )
  }

  const { data, error } = await query.returns<NotificationRow[]>()

  if (error || !Array.isArray(data) || data.length > limit) {
    return { notifications: null, nextCursor: null, error: 'Your notifications could not be loaded.' }
  }

  // Cloud message activity is bodyless too. Strip unexpected legacy payloads
  // before they reach a Server/Client Component, not just while rendering text.
  const parsed = data.map(notificationRecord)
  if (parsed.some(row => row === null)) {
    return { notifications: null, nextCursor: null, error: 'Your notifications could not be loaded.' }
  }
  const rows = parsed as NotificationRow[]
  const last = rows.at(-1)

  return {
    notifications: rows,
    nextCursor: rows.length === limit && last ? { createdAt: last.created_at, id: last.id } : null,
    error: null,
  }
}

function notificationRecord(value: unknown): NotificationRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || !row.id ||
      typeof row.type !== 'string' || typeof row.is_read !== 'boolean' ||
      typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))) return null
  for (const key of [
    'post_id', 'comment_id', 'project_id', 'idea_id', 'event_id',
    'opportunity_id', 'conversation_id',
  ]) {
    if (!(row[key] === null || typeof row[key] === 'string')) return null
  }
  if (row.type !== 'message' && !(row.body === null || typeof row.body === 'string')) return null
  let actor: NotificationRow['actor'] = null
  if (row.actor !== null) {
    if (!row.actor || typeof row.actor !== 'object' || Array.isArray(row.actor)) return null
    const person = row.actor as Record<string, unknown>
    if (typeof person.id !== 'string' || !person.id ||
        typeof person.username !== 'string' || !person.username ||
        typeof person.display_name !== 'string' ||
        !(person.avatar_url === null || typeof person.avatar_url === 'string')) return null
    actor = {
      id: person.id, username: person.username, display_name: person.display_name,
      avatar_url: person.avatar_url,
    }
  }
  const record = row as unknown as NotificationRow
  return {
    id: record.id, type: record.type, is_read: record.is_read, created_at: record.created_at,
    body: record.type === 'message' ? null : record.body, actor,
    post_id: record.post_id, comment_id: record.comment_id, project_id: record.project_id,
    idea_id: record.idea_id, event_id: record.event_id, opportunity_id: record.opportunity_id,
    conversation_id: record.conversation_id,
  }
}

/** `created_at desc, id desc` — the order the database sorts by, reproduced exactly. */
function compareNewestFirst(a: { created_at: string; id: string }, b: { created_at: string; id: string }) {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
  if (a.id === b.id) return 0
  return a.id < b.id ? 1 : -1
}

type IdRow = { id: string }
type ProjectIdRow = { id: string; slug: string }

/** The empty answer a skipped select would have produced, typed. */
const NO_IDS = { data: [] as IdRow[], error: null }
const NO_PROJECTS = { data: [] as ProjectIdRow[], error: null }

/**
 * Which of the things this page's notifications point at the reader can actually open.
 *
 * `plan.ts` decides what a link says and refuses to draw one for a target missing from
 * this index; this is the query that fills it, and it is deliberately a set of the
 * reader's own selects rather than an existence check. A post the reader may not see does
 * not come back, so it lands outside the index — which is the same conclusion as "it was
 * deleted", and the only one the list is entitled to draw. Both are rendered as "no
 * longer available", because from where the reader sits the two are indistinguishable and
 * saying which it was would leak the difference.
 *
 * `deleted_at` is checked explicitly rather than left to RLS: the policies allow reading a
 * soft-deleted row in some domains, and a link to a deleted thing is a dead link.
 *
 * One `Promise.all`, no queries when no ids of that family are on the page — a page of
 * notifications about follows and achievements (which have no target at all) makes no
 * target queries whatsoever.
 *
 * LOCAL MODE does the same seven lookups with `.filter()`: the id has to be present and
 * `deleted_at` has to be null. Two notes on what is deliberately not reproduced here.
 *
 *   * `conversations` has no `deleted_at`. Actual membership intervals authorize
 *     retained history links after leaving; message activity outside those intervals
 *     is not entitled to a link or an unread notification.
 *   * The full visibility rule for posts, projects, ideas, events and opportunities
 *     (university, connections, private) lives in each of those domains and is not copied
 *     into this file, where it would be a second copy that could drift from the one those
 *     pages use. These ids came from notifications addressed to this reader in the first
 *     place, so what is checked is the thing this file is responsible for: the row exists
 *     and it has not been soft-deleted.
 */
const TARGET_ERROR = 'The links on this page could not be resolved just now. The notifications themselves are accurate.'

export async function getTargetIndex(rows: NotificationRow[]): Promise<{
  index: TargetIndex
  error: string | null
}> {
  try {
    return await readTargetIndex(rows)
  } catch (error) {
    unstable_rethrow(error)
    return { index: emptyTargetIndex(), error: TARGET_ERROR }
  }
}

async function readTargetIndex(rows: NotificationRow[]): Promise<{
  index: TargetIndex
  /** Set when a select failed, so the page can say so instead of claiming things vanished. */
  error: string | null
}> {
  const collect = (pick: (row: NotificationRow) => string | null) =>
    [...new Set(rows.map(pick).filter((value): value is string => typeof value === 'string'))]

  const postIds = collect((row) => row.post_id)
  const commentIds = collect((row) => row.comment_id)
  const projectIds = collect((row) => row.project_id)
  const ideaIds = collect((row) => row.idea_id)
  const eventIds = collect((row) => row.event_id)
  const opportunityIds = collect((row) => row.opportunity_id)
  const conversationIds = collect((row) => row.conversation_id)

  if (isLocalMode()) {
    const db = await readStore()
    const user = await getUser()
    const profile = localActor(db, user?.id ?? null)

    const wanted = (ids: string[]) => new Set(ids)

    /** The ids that are present and not soft-deleted. */
    const live = (candidates: string[], table: { id: string; deleted_at: string | null }[]) => {
      const asked = wanted(candidates)
      return new Set(
        table.filter((row) => asked.has(row.id) && row.deleted_at === null).map((row) => row.id),
      )
    }

    const askedProjects = wanted(projectIds)
    const askedConversations = wanted(rows
      .filter(row => row.type !== 'message' || Boolean(row.conversation_id &&
        canReadConversationActivityLocal(db, row.conversation_id, row.created_at, profile)))
      .map(row => row.conversation_id)
      .filter((value): value is string => typeof value === 'string'))

    return {
      index: {
        posts: live(postIds, db.posts.filter(post =>
          localCanViewPost(post, profile, db.profiles.find(author => author.id === post.author_id), db))),
        comments: live(commentIds, db.comments.filter(row => {
          const post = db.posts.find(post => post.id === row.post_id)
          const parent = row.parent_id ? db.comments.find(comment => comment.id === row.parent_id) : null
          return contentActive(db, 'comment', row.id) && !blockedPair(db, profile?.id, row.author_id) && post && localCanViewPost(post, profile, db.profiles.find(author => author.id === post.author_id), db) && (!row.parent_id || (parent && !parent.deleted_at && contentActive(db, 'comment', parent.id) && !blockedPair(db, profile?.id, parent.author_id)))
        })),
        projects: new Map(
          db.projects
            .filter((project) => askedProjects.has(project.id) && canReadContent(db, project, project.owner_id, profile, 'project'))
            .map((project) => [project.id, project.slug]),
        ),
        ideas: live(ideaIds, db.ideas.filter(row => canReadContent(db, row, row.author_id, profile, 'idea'))),
        events: live(eventIds, db.events.filter(row => canReadContent(db, row, row.created_by, profile, 'event'))),
        opportunities: live(opportunityIds, db.opportunities.filter(row => canReadContent(db, row, row.posted_by, profile, 'opportunity'))),
        conversations: new Set(
          db.conversations
            .filter((conversation) => askedConversations.has(conversation.id))
            .filter(conversation => canReadConversationHistoryLocal(db, conversation.id, profile))
            .map((conversation) => conversation.id),
        ),
      },
      // Nothing in the store can fail to be read, so there is nothing to report. The page
      // is told the links were resolved, because they were.
      error: null,
    }
  }

  const supabase = await createClient()

  const [posts, comments, projects, ideas, events, opportunities, conversations] =
    await Promise.all([
      postIds.length
        ? supabase
            .from('posts')
            .select('id')
            .in('id', postIds)
            .is('deleted_at', null)
            .returns<IdRow[]>()
        : NO_IDS,
      commentIds.length
        ? supabase
            .from('comments')
            .select('id')
            .in('id', commentIds)
            .is('deleted_at', null)
            .returns<IdRow[]>()
        : NO_IDS,
      projectIds.length
        ? supabase
            .from('projects')
            .select('id, slug')
            .in('id', projectIds)
            .is('deleted_at', null)
            .returns<ProjectIdRow[]>()
        : NO_PROJECTS,
      ideaIds.length
        ? supabase
            .from('ideas')
            .select('id')
            .in('id', ideaIds)
            .is('deleted_at', null)
            .returns<IdRow[]>()
        : NO_IDS,
      eventIds.length
        ? supabase
            .from('events')
            .select('id')
            .in('id', eventIds)
            .is('deleted_at', null)
            .returns<IdRow[]>()
        : NO_IDS,
      opportunityIds.length
        ? supabase
            .from('opportunities')
            .select('id')
            .in('id', opportunityIds)
            .is('deleted_at', null)
            .returns<IdRow[]>()
        : NO_IDS,
      // Raw conversation SELECTs intentionally deny departed readers to protect
      // global previews. The thread's caller-scoped summary is the readable
      // history target, including after leave; select only its authorized ID.
      conversationIds.length
        ? supabase.from('message_conversation_summaries').select('id').in('id', conversationIds).returns<IdRow[]>()
        : NO_IDS,
    ])

  const targets = [
    [posts, postIds], [comments, commentIds], [projects, projectIds],
    [ideas, ideaIds], [events, eventIds], [opportunities, opportunityIds],
    [conversations, conversationIds],
  ] as const
  const validIds = (data: unknown, asked: readonly string[]): data is IdRow[] =>
    Array.isArray(data) && data.length <= asked.length &&
    data.every(row => row && typeof row === 'object' && !Array.isArray(row) &&
      typeof row.id === 'string' && asked.includes(row.id)) &&
    new Set(data.map(row => row.id)).size === data.length
  if (targets.some(([result, asked]) => result.error || !validIds(result.data, asked)) ||
      !projects.data?.every(row => typeof row.slug === 'string' && row.slug.length > 0)) {
    return { index: emptyTargetIndex(), error: TARGET_ERROR }
  }
  const ids = (result: { data: IdRow[] | null }) => new Set(result.data!.map(row => row.id))

  return {
    index: {
      posts: ids(posts),
      comments: ids(comments),
      projects: new Map(projects.data.map(row => [row.id, row.slug])),
      ideas: ids(ideas),
      events: ids(events),
      opportunities: ids(opportunities),
      conversations: ids(conversations),
    },
    error: null,
  }
}
