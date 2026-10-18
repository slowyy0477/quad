import 'server-only'

import { decodeCursor, type Cursor } from '@/lib/cursor'
import type { Database } from '@/lib/db/database.types'
import {
  readStore,
  type LocalComment,
  type LocalPost,
  type LocalProfile,
  type Tables,
} from '@/lib/local/db'
import { isLocalMode } from '@/lib/mode'
import { createClient, getUser } from '@/lib/supabase/server'

/**
 * Feed queries.
 *
 * There is no `visibility` filter in any of these selects, and that is not an
 * oversight. Row-level security decides what each row's reader is allowed to see,
 * inside Postgres, on every query. Repeating the rule here in TypeScript would
 * add a second copy that can drift out of step with the first — and the copy that
 * matters is the one an attacker cannot skip by talking to PostgREST directly.
 *
 * The two lenses are relations, not filters:
 *
 *   `public.ranked_feed`    migration 0018 — "For you", with a `feed_score` from
 *                           `app.rank_feed`, exactly as the migration describes.
 *   `public.following_feed` migration 0018 — "Following", where the restriction to
 *                           accounts the reader follows is part of the view body
 *                           rather than a filter applied here and forgettable.
 *
 * Both are `security_invoker` views, so posts, profiles, projects, goals and
 * follows RLS is evaluated as the reader — the same guarantee a plain table read
 * gives, which is why neither lens filters visibility by hand either.
 *
 * What *is* filtered here is `deleted_at` and `moderation_status`, because those are
 * not access-control questions. A removed post is invisible to everyone including
 * its author, and the policies leave it readable so moderators can review it.
 *
 * LOCAL MODE
 * ----------
 * `NEXT_PUBLIC_DATA_MODE=local` selects a second implementation, at the bottom of
 * this file, that reads `data/local.json` through `@/lib/local/db` instead of
 * Postgres. The store has no row-level security, so the rule the policies apply has
 * to be written out in TypeScript there — `localCanViewPost` — and every count is
 * derived from the like, save and comment arrays rather than read from a column
 * that nothing maintains in this mode. The Supabase paths above are untouched and
 * are still what the deployment runs.
 */

export type FeedLens = 'for-you' | 'following'

export const FEED_LENSES: readonly FeedLens[] = ['for-you', 'following'] as const

/** Narrow an untrusted query-string value to a lens. Anything else is "For you". */
export function parseLens(value: string | string[] | undefined): FeedLens {
  const raw = Array.isArray(value) ? value[0] : value
  return raw === 'following' ? 'following' : 'for-you'
}

export type AttachedProject = {
  id: string
  slug: string
  title: string
  tagline: string | null
  status: string
}

export type AttachedGoal = {
  id: string
  title: string
  status: string
  progress_percent: number | null
}

/**
 * A post as the interface renders it.
 *
 * `like_count`, `comment_count` and `save_count` are read straight from the row,
 * where they are maintained by database triggers. They are the only counts the
 * feed is allowed to show, and nothing increments them in the browser.
 *
 * `viewer_has_liked` and `viewer_has_saved` are the reader's own rows, fetched in
 * one extra round trip for the whole page rather than one per post.
 */
export type FeedPost = {
  id: string
  type: string
  title: string | null
  body: string | null
  link_url: string | null
  like_count: number
  comment_count: number
  save_count: number
  created_at: string
  is_edited: boolean
  author: {
    id: string
    username: string
    display_name: string
    avatar_url: string | null
    headline: string | null
  } | null
  project: AttachedProject | null
  goal: AttachedGoal | null
  viewer_has_liked: boolean
  viewer_has_saved: boolean
}

/** A comment as the thread renders it. Field names come from the generated row type. */
type CommentRow = Database['public']['Tables']['comments']['Row']

export type CommentPost = {
  id: CommentRow['id']
  parent_id: CommentRow['parent_id']
  body: CommentRow['body']
  like_count: CommentRow['like_count']
  reply_count: CommentRow['reply_count']
  is_edited: CommentRow['is_edited']
  created_at: CommentRow['created_at']
  author: {
    id: string
    username: string
    display_name: string
    avatar_url: string | null
    headline: string | null
  } | null
}

const PAGE_SIZE = 20

/** One lens relation, its ordering, and whether it carries a score. */
type LensSpec = {
  relation: 'ranked_feed' | 'following_feed'
  /** Ranked for "For you"; chronological for "Following". */
  ranked: boolean
}

const LENSES: Record<FeedLens, LensSpec> = {
  'for-you': { relation: 'ranked_feed', ranked: true },
  following: { relation: 'following_feed', ranked: false },
}

const FEED_COLUMNS = `
  id, author_id, type, title, body, link_url,
  like_count, comment_count, save_count, is_edited, created_at,
  project_id, goal_id,
  author_username, author_display_name, author_avatar_url, author_headline,
  project_slug, project_title, project_tagline, project_status,
  goal_title, goal_status, goal_progress_percent
`

type FeedRow = {
  id: string
  author_id: string
  type: string
  title: string | null
  body: string | null
  link_url: string | null
  like_count: number
  comment_count: number
  save_count: number
  is_edited: boolean
  created_at: string
  project_id: string | null
  goal_id: string | null
  author_username: string | null
  author_display_name: string | null
  author_avatar_url: string | null
  author_headline: string | null
  project_slug: string | null
  project_title: string | null
  project_tagline: string | null
  project_status: string | null
  goal_title: string | null
  goal_status: string | null
  goal_progress_percent: number | null
}

function toFeedPost(
  row: FeedRow,
  likedIds: ReadonlySet<string>,
  savedIds: ReadonlySet<string>,
): FeedPost {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    link_url: row.link_url,
    like_count: row.like_count,
    comment_count: row.comment_count,
    save_count: row.save_count,
    created_at: row.created_at,
    is_edited: row.is_edited,
    author:
      row.author_username && row.author_display_name
        ? {
            id: row.author_id,
            username: row.author_username,
            display_name: row.author_display_name,
            avatar_url: row.author_avatar_url,
            headline: row.author_headline,
          }
        : null,
    project:
      row.project_id && row.project_slug && row.project_title
        ? {
            id: row.project_id,
            slug: row.project_slug,
            title: row.project_title,
            tagline: row.project_tagline,
            status: row.project_status ?? 'planning',
          }
        : null,
    goal:
      row.goal_id && row.goal_title
        ? {
            id: row.goal_id,
            title: row.goal_title,
            status: row.goal_status ?? 'active',
            progress_percent: row.goal_progress_percent,
          }
        : null,
    viewer_has_liked: likedIds.has(row.id),
    viewer_has_saved: savedIds.has(row.id),
  }
}

/**
 * The reader's own like and save rows for one page of posts.
 *
 * Batched deliberately: a per-post query would be N+1, and ARCHITECTURE §3 calls
 * that a bug in `queries.ts`. `post_saves` is private to the saver by policy, so
 * asking for it as anyone else returns nothing — which is the correct answer, not
 * an error.
 */
async function viewerState(
  supabase: Awaited<ReturnType<typeof createClient>>,
  postIds: string[],
): Promise<{ liked: Set<string>; saved: Set<string> }> {
  if (postIds.length === 0) return { liked: new Set(), saved: new Set() }

  const [likes, saves] = await Promise.all([
    supabase.from('post_likes').select('post_id').in('post_id', postIds),
    supabase.from('post_saves').select('post_id').in('post_id', postIds),
  ])

  if (likes.error) console.error('[feed:viewerLikes]', likes.error.code, likes.error.message)
  if (saves.error) console.error('[feed:viewerSaves]', saves.error.code, saves.error.message)

  return {
    liked: new Set((likes.data ?? []).map((row) => row.post_id as string)),
    saved: new Set((saves.data ?? []).map((row) => row.post_id as string)),
  }
}

/**
 * One page of the feed, for one lens.
 *
 * Keyset pagination rather than `offset`: a feed that people write to while you
 * are reading it shifts under an offset, so page two silently skips or repeats
 * rows. The cursor is `(created_at, id)` — `created_at` alone is not unique, and a
 * page boundary landing between two rows written in the same millisecond repeats
 * one of them forever.
 *
 * The two lenses need different boundaries, and the difference matters:
 *
 *   * **Following** is chronological, so the boundary is the same pair the ORDER BY
 *     ends with: strictly `<` on `(created_at, id)`. Each page takes its rows from
 *     a subset strictly older than the cursor, so no row can appear twice.
 *   * **For you** is ordered by `feed_score` first, so a `(created_at, id)` boundary
 *     would be the wrong question: it asks for rows *older than the boundary* while
 *     the ordering promises rows *ranked below the boundary*. A recent post that
 *     ranks below the boundary is then dropped forever — never on page one, because
 *     it lost on score, and never on page two, because it is newer than the cursor.
 *     That is not a corner case; it is what a quiet post written during the session
 *     looks like. So the boundary is the whole sort key:
 *
 *         (feed_score, created_at, id) < (boundary_score, boundary_created_at, boundary_id)
 *
 *     The boundary row's score is read back with one extra query, because the score
 *     cannot be carried in a two-field cursor. Re-reading it is exact, not
 *     approximate, and that is the reason 0018 floors the ranking clock to the day:
 *     a score computed from the exact instant changes between two requests, and the
 *     boundary would then sit below rows the reader has already seen — page two
 *     would begin by repeating page one. With a stable score the comparison is
 *     exact, and because the order is total a page can never repeat a row.
 *
 * Ordering is always total. `id` last is not decoration: two posts written in the
 * same millisecond with the same score are otherwise unordered, and a cursor placed
 * between them repeats one of them forever.
 */
export async function getFeedPosts({
  lens = 'for-you',
  limit = PAGE_SIZE,
  cursor,
}: {
  lens?: FeedLens
  limit?: number
  cursor?: string | string[]
} = {}): Promise<{ posts: FeedPost[] | null; nextCursor: Cursor | null; error: string | null }> {
  if (isLocalMode()) return localFeedPosts({ lens, limit, cursor })

  const supabase = await createClient()
  const decoded = decodeCursor(Array.isArray(cursor) ? cursor[0] : cursor)
  const spec = LENSES[lens]

  let query = supabase.from(spec.relation).select(FEED_COLUMNS)

  if (spec.ranked) {
    // The canonical ordering from migration 0018's header. All three keys, so the
    // order is total and a cursor cannot loop.
    query = query
      .order('feed_score', { ascending: false })
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
  } else {
    query = query.order('created_at', { ascending: false }).order('id', { ascending: false })
  }

  if (decoded) {
    const chronological = `created_at.lt.${decoded.createdAt},and(created_at.eq.${decoded.createdAt},id.lt.${decoded.id})`

    if (!spec.ranked) {
      query = query.or(chronological)
    } else {
      const score = await boundaryScore(supabase, decoded.id)
      query =
        score === null
          ? // The boundary row is gone — deleted or no longer visible between the
            // two requests. `created_at` alone can only *drop* rows, never repeat
            // one, so this falls back to the conservative boundary rather than
            // paginating from an invented score.
            query.or(chronological)
          : query.or(
              `feed_score.lt.${score},` +
                `and(feed_score.eq.${score},created_at.lt.${decoded.createdAt}),` +
                `and(feed_score.eq.${score},created_at.eq.${decoded.createdAt},id.lt.${decoded.id})`,
            )
    }
  }

  const { data, error } = await query.limit(limit).returns<FeedRow[]>()

  if (error) {
    // Logged in full, reported as a sentence. A PostgREST error message can name
    // tables, columns and constraints, which is a free map of the schema.
    console.error('[feed:getFeedPosts]', error.code, error.message)
    return { posts: null, nextCursor: null, error: 'The feed could not be loaded. Please try again.' }
  }

  const rows = data ?? []
  const { liked, saved } = await viewerState(
    supabase,
    rows.map((row) => row.id),
  )
  const last = rows.at(-1)

  return {
    posts: rows.map((row) => toFeedPost(row, liked, saved)),
    // A full page means there may be more; a short page is the real end of the
    // list, which is what `EndOfList` renders rather than an endless spinner.
    nextCursor:
      rows.length === limit && last ? { createdAt: last.created_at, id: last.id } : null,
    error: null,
  }
}

/**
 * The `feed_score` of one row, as the "For you" lens computes it.
 *
 * Read through the lens view rather than by calling `app.rank_feed` with the row's
 * columns, so there is exactly one implementation of the formula and this cannot
 * drift from the score the rows were ordered by — including the clock the view
 * chooses, which is floored to the day (see 0018's header) so that this value and
 * the rows it bounds are computed from the same number. `null` means the row is no
 * longer readable, and the caller then refuses to paginate from a score it cannot
 * verify.
 */
async function boundaryScore(
  supabase: Awaited<ReturnType<typeof createClient>>,
  id: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('ranked_feed')
    .select('feed_score')
    .eq('id', id)
    .maybeSingle<{ feed_score: number | string }>()

  if (error) {
    console.error('[feed:boundaryScore]', error.code, error.message)
    return null
  }
  if (!data) return null
  return String(data.feed_score)
}

const DETAIL_SELECT = `
  id, type, title, body, link_url, like_count, comment_count, save_count,
  is_edited, created_at, visibility, author_id,
  author:profiles!posts_author_id_fkey ( id, username, display_name, avatar_url, headline ),
  project:projects!posts_project_id_fkey ( id, slug, title, tagline, status ),
  goal:goals!posts_goal_id_fkey ( id, title, status, progress_percent )
`

type DetailRow = {
  id: string
  type: string
  title: string | null
  body: string | null
  link_url: string | null
  like_count: number
  comment_count: number
  save_count: number
  is_edited: boolean
  created_at: string
  visibility: string
  author_id: string
  author: FeedPost['author']
  project: AttachedProject | null
  goal: AttachedGoal | null
}

export type PostDetail = FeedPost & {
  visibility: string
  author_id: string
}

/**
 * One post, for its permalink.
 *
 * `null` covers both "no such post" and "not allowed to see it", and the caller
 * turns both into a refusal. Telling the two apart would confirm the existence of a
 * post to exactly the person who was refused access to it.
 *
 * Read straight from `posts` rather than from `ranked_feed`, for one reason: this
 * route has to work for a signed-out visitor on a public post, and the lens views
 * are granted to `authenticated` only. RLS is the same either way.
 */
export async function getPostDetail(id: string): Promise<PostDetail | null> {
  if (isLocalMode()) return localPostDetail(id)

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('posts')
    .select(DETAIL_SELECT)
    .eq('id', id)
    .maybeSingle<DetailRow>()

  if (error) {
    console.error('[feed:getPostDetail]', error.code, error.message)
    return null
  }
  if (!data) return null

  const { liked, saved } = await viewerState(supabase, [data.id])

  return {
    ...toFeedPost(
      {
        ...data,
        author_username: data.author?.username ?? null,
        author_display_name: data.author?.display_name ?? null,
        author_avatar_url: data.author?.avatar_url ?? null,
        author_headline: data.author?.headline ?? null,
        project_id: data.project?.id ?? null,
        project_slug: data.project?.slug ?? null,
        project_title: data.project?.title ?? null,
        project_tagline: data.project?.tagline ?? null,
        project_status: data.project?.status ?? null,
        goal_id: data.goal?.id ?? null,
        goal_title: data.goal?.title ?? null,
        goal_status: data.goal?.status ?? null,
        goal_progress_percent: data.goal?.progress_percent ?? null,
      },
      liked,
      saved,
    ),
    visibility: data.visibility,
    author_id: data.author_id,
  }
}

const COMMENT_SELECT = `
  id, parent_id, body, like_count, reply_count, is_edited, created_at,
  author:profiles!comments_author_id_fkey ( id, username, display_name, avatar_url, headline )
`

type CommentJoinRow = {
  id: string
  parent_id: string | null
  body: string
  like_count: number
  reply_count: number
  is_edited: boolean
  created_at: string
  author: CommentPost['author']
}

function toCommentPost(row: CommentJoinRow): CommentPost {
  return {
    id: row.id,
    parent_id: row.parent_id,
    body: row.body,
    like_count: row.like_count,
    reply_count: row.reply_count,
    is_edited: row.is_edited,
    created_at: row.created_at,
    author: row.author,
  }
}

/**
 * The top-level comments on one post, oldest first — a thread read top to bottom is
 * the only reading order in which replies make sense.
 *
 * `parent_id is null` is the thread's spine, and it is filtered in SQL rather than
 * after the fetch so the page size means "twenty comments", not "twenty rows,
 * some of which are replies". Replies are fetched separately and batched, because
 * a per-comment query for them would be N+1.
 *
 * Keyset again, in the other direction: `(created_at, id)` strictly *greater* than
 * the cursor, matching `comments_post_idx`, which is
 * `(post_id, created_at asc, id asc)` for exactly this query. RLS decides which
 * comments are visible — `comments_select` calls `app.can_view_post(post_id)` — so
 * a comment on a post the reader cannot see never appears.
 */
export async function getPostComments(
  postId: string,
  { limit = 20, cursor }: { limit?: number; cursor?: string | string[] } = {},
): Promise<{ comments: CommentPost[] | null; nextCursor: Cursor | null; error: string | null }> {
  if (isLocalMode()) return localComments(postId, { limit, cursor })

  const supabase = await createClient()
  const decoded = decodeCursor(Array.isArray(cursor) ? cursor[0] : cursor)

  let query = supabase
    .from('comments')
    .select(COMMENT_SELECT)
    .eq('post_id', postId)
    .is('parent_id', null)
    .is('deleted_at', null)
    .eq('moderation_status', 'active')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })

  if (decoded) {
    query = query.or(
      `created_at.gt.${decoded.createdAt},and(created_at.eq.${decoded.createdAt},id.gt.${decoded.id})`,
    )
  }

  const { data, error } = await query.limit(limit).returns<CommentJoinRow[]>()
  if (error) {
    console.error('[feed:getPostComments]', error.code, error.message)
    return { comments: null, nextCursor: null, error: 'The comments could not be loaded.' }
  }

  const rows = data ?? []
  const last = rows.at(-1)

  return {
    comments: rows.map(toCommentPost),
    nextCursor: rows.length === limit && last ? { createdAt: last.created_at, id: last.id } : null,
    error: null,
  }
}

/**
 * The replies to one page of top-level comments, in one query.
 *
 * Depth is capped at one by `comments_before_write`, so this is the whole of the
 * thread below each parent — there is no second level to fetch.
 */
export async function getCommentReplies(parentIds: string[]): Promise<CommentPost[]> {
  if (parentIds.length === 0) return []
  if (isLocalMode()) return localReplies(parentIds)

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('comments')
    .select(COMMENT_SELECT)
    .in('parent_id', parentIds)
    .is('deleted_at', null)
    .eq('moderation_status', 'active')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .returns<CommentJoinRow[]>()

  if (error) {
    console.error('[feed:getCommentReplies]', error.code, error.message)
    return []
  }

  return (data ?? []).map(toCommentPost)
}

export type UniversityPeer = {
  id: string
  username: string
  display_name: string
  avatar_url: string | null
  headline: string | null
}

/**
 * People who share the reader's university.
 *
 * The destination of the "Following" lens's empty state: a new account follows
 * nobody, so the honest answer is not a blank page but a list of the people it
 * could follow. `profiles.university_id` is the only stored affiliation there is
 * (departments and programmes are not listed yet), and RLS decides who is visible —
 * this makes no attempt to filter visibility by hand.
 *
 * Not paginated: this is a starting point, not a directory, and it says so on the
 * page rather than pretending to be exhaustive.
 */
export async function listUniversityPeers(
  limit = 40,
): Promise<{ peers: UniversityPeer[] | null; universityId: string | null; error: string | null }> {
  if (isLocalMode()) return localUniversityPeers(limit)

  const user = await getUser()
  if (!user) return { peers: [], universityId: null, error: null }

  const supabase = await createClient()

  const profile = await supabase
    .from('profiles')
    .select('university_id')
    .eq('id', user.id)
    .maybeSingle<{ university_id: string | null }>()

  if (profile.error) {
    console.error('[feed:listUniversityPeers:profile]', profile.error.code, profile.error.message)
    return { peers: null, universityId: null, error: 'Your university could not be read.' }
  }

  const universityId = profile.data?.university_id ?? null
  if (!universityId) return { peers: [], universityId: null, error: null }

  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, display_name, avatar_url, headline')
    .eq('university_id', universityId)
    .neq('id', user.id)
    .is('deleted_at', null)
    .eq('status', 'active')
    .order('display_name')
    .limit(limit)
    .returns<UniversityPeer[]>()

  if (error) {
    console.error('[feed:listUniversityPeers]', error.code, error.message)
    return { peers: null, universityId, error: 'People from your university could not be loaded.' }
  }

  return { peers: data ?? [], universityId, error: null }
}

export type AttachOption = { id: string; label: string; hint: string | null }

/**
 * The reader's own goals and projects, for the composer's attach picker.
 *
 * Projects come from `features/projects/queries` — a cross-domain read through the
 * owning feature's exported query, which is what the import rules require. Goals
 * are read here because there is no `features/goals` module yet and a post's
 * attachment is a feed concern; the day one exists this moves behind its query.
 *
 * Both lists are the reader's own, which is not a convenience: `posts_before_write`
 * refuses a project anchor from a non-member and `posts_goal_anchor` refuses a goal
 * that is not the author's, so offering anything else would be offering an action
 * that cannot succeed.
 */
export async function listMyGoals(limit = 50): Promise<AttachOption[]> {
  if (isLocalMode()) return localGoals(limit)

  const user = await getUser()
  if (!user) return []

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('goals')
    .select('id, title, status, visibility')
    .eq('profile_id', user.id)
    .order('created_at', { ascending: false })
    .limit(limit)
    .returns<{ id: string; title: string; status: string; visibility: string }[]>()

  if (error) {
    console.error('[feed:listMyGoals]', error.code, error.message)
    return []
  }

  return (data ?? []).map((goal) => ({
    id: goal.id,
    label: goal.title,
    hint: goal.visibility === 'private' ? 'Private goal' : null,
  }))
}

// =============================================================================
// Local mode
// =============================================================================
//
// The store is a JSON file with no query language, so everything the Postgres
// paths get from RLS and from the trigger-maintained counters is done here, in
// TypeScript, literally: `localCanViewPost` is `app.can_view_post` transcribed, and
// every count is counted from the rows that cause it.
//
// Two relations genuinely do not exist locally — **follows** and **connections** —
// and each is answered with the narrowest true answer at the place it bites,
// rather than approximated into something that looks like a working feature.

/**
 * The store, and the reader's profile in it.
 *
 * `getUser()` is the mode-aware one: in local mode it verifies the signed cookie,
 * returns `{ id, email, user_metadata }` and seeds the store on first use, so it has
 * to be awaited before `readStore()` for a fresh clone to have anything in it.
 *
 * The reader's profile is found by `user_id`, not by `id`: Postgres makes
 * `profiles.id` equal to `auth.uid()`, and the local store does not.
 */
async function localContext(): Promise<{ db: Tables; me: LocalProfile | null }> {
  const user = await getUser()
  const db = await readStore()
  const me = user ? (db.profiles.find((profile) => profile.user_id === user.id) ?? null) : null
  return { db, me }
}

/**
 * `app.can_view_post` (migration 0008), transcribed.
 *
 *   author is the reader
 *   or ( not deleted, moderation active, and
 *        public
 *        or university and both profiles carry the same, non-null university_id
 *        or connections and the two profiles are connected )
 *
 * Three clauses have no local equivalent, and each fails closed:
 *
 *   connections  the store has no connections table, so a `connections` post is
 *                visible to its author alone. Broadening it to "everyone" would
 *                publish posts their authors wrote for a smaller audience.
 *   blocked      no blocks table, so nobody is blocked.
 *   moderator    no roles table, so `is_moderator()` is false everywhere.
 *
 * `deleted_at` and `moderation_status` are checked for the author too, because the
 * selects above filter them for everyone — a removed post is invisible to everyone,
 * which is this file's stated rule. (The Supabase permalink leans on the policy
 * instead, so local mode is the stricter of the two here.)
 *
 * Exported because `actions.ts` has to answer the same question before it writes a
 * like, a save or a comment, and one predicate is one place to get it wrong.
 */
export function localCanViewPost(
  post: LocalPost,
  reader: LocalProfile | null,
  author: LocalProfile | undefined,
): boolean {
  if (post.deleted_at !== null) return false
  if (reader && post.author_id === reader.id) return true
  if (post.moderation_status !== 'active') return false
  if (post.visibility === 'public') return true
  if (post.visibility === 'university') return localSharesUniversity(reader, author)
  return false // 'connections' (no such relation locally) and 'private'
}

/** `app.share_university`: both profiles known, both with the same institution. */
function localSharesUniversity(reader: LocalProfile | null, other: LocalProfile | undefined): boolean {
  if (!reader?.university_id || !other?.university_id) return false
  return reader.university_id === other.university_id
}

/**
 * `created_at` descending, then `id` descending — the total order the feed's cursor
 * is built on. Two posts written in the same millisecond are otherwise unordered,
 * and a cursor placed between them would repeat one of them forever.
 */
function newestFirst(a: { created_at: string; id: string }, b: { created_at: string; id: string }): number {
  const left = Date.parse(a.created_at)
  const right = Date.parse(b.created_at)
  if (left !== right) return right - left
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

/** `created_at` ascending, then `id` ascending — the direction a thread is read in. */
function oldestFirst(a: { created_at: string; id: string }, b: { created_at: string; id: string }): number {
  const left = Date.parse(a.created_at)
  const right = Date.parse(b.created_at)
  if (left !== right) return left - right
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Strictly below the cursor in `newestFirst` order: the next page of the feed. */
function isOlderThan(row: { created_at: string; id: string }, cursor: Cursor): boolean {
  const time = Date.parse(row.created_at)
  const boundary = Date.parse(cursor.createdAt)
  if (time !== boundary) return time < boundary
  return row.id < cursor.id
}

/** Strictly above the cursor in `oldestFirst` order: the next page of a thread. */
function isNewerThan(row: { created_at: string; id: string }, cursor: Cursor): boolean {
  const time = Date.parse(row.created_at)
  const boundary = Date.parse(cursor.createdAt)
  if (time !== boundary) return time > boundary
  return row.id > cursor.id
}

/**
 * Decode a cursor against the store's own id scheme.
 *
 * `decodeCursor` insists the id is a uuid, because a uuid is what Postgres mints
 * and anything else is a tampered or truncated cursor. The local store mints
 * `<prefix>_<base36>` ids instead (see `id()` in `@/lib/local/db`), so that guard
 * rejects every cursor this file produces and page two would silently render page
 * one for ever. The encoding and the shape are unchanged — base64url over
 * `created_at|id` — and the timestamp is still checked; only the id's shape is
 * checked against the store's scheme rather than Postgres's.
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

/**
 * Whether the reader may see a row that carries its own `visibility` — a project or
 * a goal — so an attachment is dropped exactly when the embed in `DETAIL_SELECT`
 * would have come back as `null` because RLS refused it. Same rule as posts,
 * including the missing-`connections` caveat: visible to its owner only.
 */
function localCanSeeOwned(
  visibility: string,
  ownerId: string,
  reader: LocalProfile | null,
  owner: LocalProfile | undefined,
): boolean {
  if (reader && reader.id === ownerId) return true
  if (visibility === 'public') return true
  if (visibility === 'university') return localSharesUniversity(reader, owner)
  return false
}

/**
 * One local post, in the shape the card renders.
 *
 * Every count is derived: `post_likes`, `post_saves` and `comments` are the rows the
 * Postgres triggers read, so they are the same numbers here, and the cached columns
 * on the post row are ignored because nothing maintains them locally.
 *
 * Four fields have no local column and are reported as what they are rather than
 * filled in: `title` and `link_url` (the composer collects neither), `is_edited`
 * (nothing records an edit), and `type`, which is derived from the attachment by
 * the same rule `createPostAction` applies on insert.
 */
function localFeedPost(post: LocalPost, db: Tables, me: LocalProfile | null): FeedPost {
  const author = db.profiles.find((profile) => profile.id === post.author_id)

  const projectRow = post.project_id
    ? db.projects.find((project) => project.id === post.project_id)
    : undefined
  const projectOwner = projectRow
    ? db.profiles.find((profile) => profile.id === projectRow.owner_id)
    : undefined

  const goalRow = post.goal_id ? db.goals.find((goal) => goal.id === post.goal_id) : undefined

  const project =
    projectRow &&
    projectRow.deleted_at === null &&
    localCanSeeOwned(projectRow.visibility, projectRow.owner_id, me, projectOwner)
      ? {
          id: projectRow.id,
          slug: projectRow.slug,
          title: projectRow.title,
          // `projects.purpose` is the store's one-line summary; the card's tagline
          // slot is exactly that sentence.
          tagline: projectRow.purpose,
          status: projectRow.status,
        }
      : null

  const goal =
    goalRow && localCanSeeOwned(goalRow.visibility, goalRow.profile_id, me, author)
      ? {
          id: goalRow.id,
          title: goalRow.title,
          status: goalRow.status,
          progress_percent: goalRow.progress_percent,
        }
      : null

  return {
    id: post.id,
    type: post.project_id ? 'project_update' : post.goal_id ? 'learning_update' : 'text',
    title: null,
    body: post.body,
    link_url: null,
    like_count: db.post_likes.filter((like) => like.post_id === post.id).length,
    comment_count: db.comments.filter(
      (comment) => comment.post_id === post.id && comment.deleted_at === null,
    ).length,
    save_count: db.post_saves.filter((save) => save.post_id === post.id).length,
    created_at: post.created_at,
    is_edited: false,
    author: author
      ? {
          id: author.id,
          username: author.username,
          display_name: author.display_name,
          avatar_url: author.avatar_url,
          // The local profile has no free-text `headline`; `department` is the
          // stored affiliation the card has room for, and null when it is unset.
          headline: author.department,
        }
      : null,
    project,
    goal,
    viewer_has_liked: me
      ? db.post_likes.some((like) => like.post_id === post.id && like.profile_id === me.id)
      : false,
    viewer_has_saved: me
      ? db.post_saves.some((save) => save.post_id === post.id && save.profile_id === me.id)
      : false,
  }
}

/**
 * `getFeedPosts` against the store.
 *
 * **For you** is every post the reader may see, newest first. The Supabase lens
 * orders by `feed_score` first and paginates on `(feed_score, created_at, id)`,
 * re-reading the boundary row's score because the two-field cursor cannot carry it
 * (see the long note above). Reproducing that here would mean either changing the
 * cursor shape or ordering by a score and paginating by `created_at` — and the
 * second repeats rows, which is the one thing keyset pagination exists to prevent.
 * So this lens is chronological, paginated on `(created_at, id)` exactly like the
 * Following lens, and it is a total order in both modes.
 *
 * **Following** is empty, and not because nobody follows anybody: the store has no
 * `follows` table and no code that could create a row in one, so a following feed
 * cannot be computed at all. Returning `[]` with no error is the honest answer and
 * makes the lens render its real empty state — which says "you follow nobody yet"
 * and links to the people list — instead of showing every post under a heading that
 * claims the reader follows them.
 */
async function localFeedPosts({
  lens,
  limit,
  cursor,
}: {
  lens: FeedLens
  limit: number
  cursor?: string | string[]
}): Promise<{ posts: FeedPost[] | null; nextCursor: Cursor | null; error: string | null }> {
  const { db, me } = await localContext()

  if (lens === 'following') return { posts: [], nextCursor: null, error: null }

  const authorOf = (post: LocalPost) => db.profiles.find((profile) => profile.id === post.author_id)
  const decoded = decodeLocalCursor(cursor)

  const visible = db.posts
    .filter((post) => localCanViewPost(post, me, authorOf(post)))
    .sort(newestFirst)

  const rows = (decoded ? visible.filter((post) => isOlderThan(post, decoded)) : visible).slice(
    0,
    limit,
  )
  const last = rows.at(-1)

  return {
    posts: rows.map((post) => localFeedPost(post, db, me)),
    nextCursor: rows.length === limit && last ? { createdAt: last.created_at, id: last.id } : null,
    error: null,
  }
}

/** `getPostDetail` against the store. `null` is both "no such post" and "not yours to see". */
async function localPostDetail(id: string): Promise<PostDetail | null> {
  const { db, me } = await localContext()
  const post = db.posts.find((candidate) => candidate.id === id)
  if (!post) return null

  const author = db.profiles.find((profile) => profile.id === post.author_id)
  if (!localCanViewPost(post, me, author)) return null

  return {
    ...localFeedPost(post, db, me),
    visibility: post.visibility,
    author_id: post.author_id,
  }
}

/**
 * One comment, in the shape the thread renders.
 *
 * `like_count` is 0 because the store has no `comment_likes` table — that is the
 * true number of likes on a comment here, and nothing on the page claims otherwise.
 * `reply_count` is counted from the replies that exist. `is_edited` is false: no
 * column records an edit.
 */
function localCommentPost(comment: LocalComment, db: Tables): CommentPost {
  const author = db.profiles.find((profile) => profile.id === comment.author_id)

  return {
    id: comment.id,
    parent_id: comment.parent_id,
    body: comment.body,
    like_count: 0,
    reply_count: db.comments.filter(
      (candidate) => candidate.parent_id === comment.id && candidate.deleted_at === null,
    ).length,
    is_edited: false,
    created_at: comment.created_at,
    author: author
      ? {
          id: author.id,
          username: author.username,
          display_name: author.display_name,
          avatar_url: author.avatar_url,
          headline: author.department,
        }
      : null,
  }
}

/**
 * `getPostComments` against the store.
 *
 * `comments_select` is `app.can_view_post(post_id)`, so a comment on a post the
 * reader cannot see does not exist for them. An empty page is what RLS produces for
 * that case, so an empty page is what this returns — not an error, which would tell
 * the reader the post is there.
 */
async function localComments(
  postId: string,
  { limit, cursor }: { limit: number; cursor?: string | string[] },
): Promise<{ comments: CommentPost[] | null; nextCursor: Cursor | null; error: string | null }> {
  const { db, me } = await localContext()
  const post = db.posts.find((candidate) => candidate.id === postId)
  if (!post) return { comments: [], nextCursor: null, error: null }

  const author = db.profiles.find((profile) => profile.id === post.author_id)
  if (!localCanViewPost(post, me, author)) return { comments: [], nextCursor: null, error: null }

  const decoded = decodeLocalCursor(cursor)
  const rows = db.comments
    .filter(
      (comment) =>
        comment.post_id === postId && comment.parent_id === null && comment.deleted_at === null,
    )
    .sort(oldestFirst)
    .filter((comment) => (decoded ? isNewerThan(comment, decoded) : true))
    .slice(0, limit)

  const last = rows.at(-1)

  return {
    comments: rows.map((comment) => localCommentPost(comment, db)),
    nextCursor: rows.length === limit && last ? { createdAt: last.created_at, id: last.id } : null,
    error: null,
  }
}

/** `getCommentReplies` against the store: one level, on posts the reader may see. */
async function localReplies(parentIds: string[]): Promise<CommentPost[]> {
  const { db, me } = await localContext()
  const parents = new Set(parentIds)

  const visiblePostIds = new Set(
    db.posts
      .filter((post) =>
        localCanViewPost(post, me, db.profiles.find((profile) => profile.id === post.author_id)),
      )
      .map((post) => post.id),
  )

  return db.comments
    .filter(
      (comment) =>
        comment.parent_id !== null &&
        parents.has(comment.parent_id) &&
        comment.deleted_at === null &&
        visiblePostIds.has(comment.post_id),
    )
    .sort(oldestFirst)
    .map((comment) => localCommentPost(comment, db))
}

/** `listUniversityPeers` against the store. */
async function localUniversityPeers(
  limit: number,
): Promise<{ peers: UniversityPeer[] | null; universityId: string | null; error: string | null }> {
  const { db, me } = await localContext()
  if (!me) return { peers: [], universityId: null, error: null }
  if (!me.university_id) return { peers: [], universityId: null, error: null }

  // `profiles_select` shows a profile that is public and searchable. Anything else
  // is not in this list, exactly as it is not in the Supabase one.
  const peers = db.profiles
    .filter(
      (profile) =>
        profile.id !== me.id &&
        profile.university_id === me.university_id &&
        profile.visibility === 'public' &&
        profile.searchable,
    )
    .sort((a, b) => a.display_name.localeCompare(b.display_name))
    .slice(0, limit)
    .map((profile) => ({
      id: profile.id,
      username: profile.username,
      display_name: profile.display_name,
      avatar_url: profile.avatar_url,
      headline: profile.department,
    }))

  return { peers, universityId: me.university_id, error: null }
}

/**
 * `listMyGoals` against the store.
 *
 * The reader's own goals only, for the same reason the Supabase path does it: the
 * composer offers an attachment that will pass `posts_goal_anchor`, and a goal that
 * is not the author's would be refused at write time.
 */
async function localGoals(limit: number): Promise<AttachOption[]> {
  const { db, me } = await localContext()
  if (!me) return []

  return db.goals
    .filter((goal) => goal.profile_id === me.id)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, limit)
    .map((goal) => ({
      id: goal.id,
      label: goal.title,
      hint: goal.visibility === 'private' ? 'Private goal' : null,
    }))
}
