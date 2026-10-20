import 'server-only'

import { decodeCursor, type Cursor } from '@/lib/cursor'
import { readStore, type LocalIdea, type LocalProfile, type Tables } from '@/lib/local/db'
import { isLocalMode } from '@/lib/mode'
import { createClient, getUser } from '@/lib/supabase/server'
import { localCanViewPost } from '@/features/feed/queries'
import { canViewEvent, localEventSlug } from '@/features/events/queries'
import { canViewOpportunity, localOpportunitySlug } from '@/features/opportunities/queries'
import {
  canViewLocalProfile,
  localViewer,
  type LocalViewer,
  type ProfileSummary,
} from '@/features/profiles/queries'
import { canSeeProject, type ProjectListItem } from '@/features/projects/queries'

/**
 * Search reads.
 *
 * There is one call here — `public.search_all` — and it is a Postgres function
 * rather than a chain of PostgREST filters, because a relevance question cannot be
 * expressed as one. PostgREST can filter a table by a column and order by a column;
 * it cannot order by `similarity(column, $query)`, and it cannot ask six tables in
 * one round trip.
 *
 * The migration behind it (0019_search.sql) is where the interesting decisions are
 * written down: which columns are searched and which indexes serve them, why the
 * score is trigram similarity and nothing else, and why the function is
 * `security invoker`. This module's job is to hand it a query and shape the answer.
 *
 * **There is no visibility filter in the Supabase path**, and that is the same
 * decision the feed and project modules make. The function runs as the reader, so
 * row-level security filters every row inside Postgres: a private project is
 * invisible to a non-member, a blocked reader sees nothing from the blocker or the
 * blocked, a `university`-scoped profile is invisible across institutions, and a
 * profile with `searchable = false` is not in the index of the findable. Repeating
 * any of that here would create a second copy of the rule that an attacker can skip
 * by calling PostgREST directly, and the copy that matters is the one they cannot.
 *
 * LOCAL MODE
 * ----------
 * `NEXT_PUBLIC_DATA_MODE=local` selects `localSearchAll`, at the bottom of this
 * file: there is no Postgres to hold `public.search_all`, so the function is written
 * out in TypeScript over `data/local.json`. With no policy to lean on, that path
 * *has* to apply visibility itself — and it does it by calling the owning feature's
 * exported predicate (projects, feed, ideas, opportunities, events, profiles) rather
 * than by keeping a sixth copy of each rule here. The Supabase body above is
 * untouched and is still what the deployment runs.
 */

/** The six kinds, in the order the tabs appear. Singular, and used in the URL. */
export const SEARCH_KINDS = [
  'person',
  'project',
  'post',
  'idea',
  'opportunity',
  'event',
] as const

export type SearchKind = (typeof SEARCH_KINDS)[number]

export const DEFAULT_KIND: SearchKind = 'person'

/** Below this, the function returns nothing. See the migration header for why. */
export const MIN_QUERY_LENGTH = 2

export const PAGE_SIZE = 20

export type SearchKindSpec = {
  kind: SearchKind
  /** Tab label. Plural, because a tab is a collection. */
  label: string
  singular: string
  plural: string
  /** What this kind's search actually looks at. Used in the empty states. */
  matches: string
}

/**
 * The tabs, and the copy they need.
 *
 * `matches` is not decoration: it is what the no-results state tells the reader
 * instead of shrugging, and it is written from the SQL rather than from an
 * intention — a project is matched on its title, not on its tagline, and saying
 * otherwise here would be a promise the database does not keep.
 */
export const SEARCH_KIND_SPECS: readonly SearchKindSpec[] = [
  {
    kind: 'person',
    label: 'People',
    singular: 'person',
    plural: 'people',
    matches: 'display names and usernames',
  },
  {
    kind: 'project',
    label: 'Projects',
    singular: 'project',
    plural: 'projects',
    matches: 'project titles',
  },
  { kind: 'post', label: 'Posts', singular: 'post', plural: 'posts', matches: 'post text' },
  { kind: 'idea', label: 'Ideas', singular: 'idea', plural: 'ideas', matches: 'idea titles' },
  {
    kind: 'opportunity',
    label: 'Opportunities',
    singular: 'opportunity',
    plural: 'opportunities',
    matches: 'opportunity titles',
  },
  { kind: 'event', label: 'Events', singular: 'event', plural: 'events', matches: 'event titles' },
] as const

export function kindSpec(kind: SearchKind): SearchKindSpec {
  const spec = SEARCH_KIND_SPECS.find((candidate) => candidate.kind === kind)
  // Unreachable for a SearchKind, and a type error rather than a missing tab if the
  // two ever drift apart.
  if (!spec) throw new Error(`No search tab spec for kind "${kind}"`)
  return spec
}

/**
 * Narrow an untrusted `?tab=` to a kind.
 *
 * Anything unrecognised is the default kind, so a mangled or hand-edited URL
 * degrades to people rather than raising. The function would return nothing for an
 * unknown kind, which is safe but is a blank page with no explanation; this is the
 * better failure.
 */
export function parseKind(value: string | string[] | undefined): SearchKind {
  const raw = Array.isArray(value) ? value[0] : value
  return SEARCH_KINDS.includes(raw as SearchKind) ? (raw as SearchKind) : DEFAULT_KIND
}

/** A query string value, first-wins. */
export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** The reader's search text, trimmed, or `''`. */
export function parseQuery(value: string | string[] | undefined): string {
  return (firstParam(value) ?? '').trim()
}

/**
 * One instance of a search result, as the interface renders it.
 *
 * A discriminated union, so that `result.project.slug` is a compile-time fact
 * rather than a null check at each render site: a person has a handle and no slug,
 * a post has counts and no slug, and the components that draw them take the
 * narrowed type rather than the union.
 *
 * Every field here is a column the function returned, which in turn is a stored
 * column. Nothing is derived, estimated or counted in the browser.
 */
export type SearchResult =
  | { kind: 'person'; id: string; created_at: string; person: ProfileSummary }
  | { kind: 'project'; id: string; created_at: string; project: ProjectListItem }
  | { kind: 'post'; id: string; created_at: string; post: SearchPost }
  | { kind: 'idea'; id: string; created_at: string; idea: SearchIdea }
  | { kind: 'opportunity'; id: string; created_at: string; opportunity: SearchOpportunity }
  | { kind: 'event'; id: string; created_at: string; event: SearchEvent }

export type SearchPost = {
  id: string
  title: string | null
  /** `posts.body`, truncated by the function to 200 characters. */
  excerpt: string | null
  type: string
  like_count: number
  comment_count: number
  created_at: string
  author: ProfileSummary | null
}

export type SearchIdea = {
  id: string
  title: string
  /** `ideas.description`, truncated by the function to 200 characters. */
  excerpt: string | null
  category: string
  status: string
  upvote_count: number
  interest_count: number
  created_at: string
  author: ProfileSummary | null
}

export type SearchOpportunity = {
  id: string
  slug: string
  title: string
  organisation: string | null
  type: string
  status: string
  deadline: string | null
  created_at: string
  author: ProfileSummary | null
}

export type SearchEvent = {
  id: string
  slug: string
  title: string
  type: string
  location: string | null
  starts_at: string
  created_at: string
  author: ProfileSummary | null
}

export type SearchResultsPage = {
  /** `null` when the request failed. An empty array is a real empty result. */
  results: SearchResult[] | null
  /**
   * The exact number of visible matches, from `count(*)` inside the function.
   *
   * `null` means "not known", and it has one cause: a page fetched with a cursor
   * that came back empty, where there is no row to carry the count. The page then
   * renders "that is everything" rather than inventing a zero.
   */
  total: number | null
  nextCursor: Cursor | null
  error: string | null
}

/** The row shape `public.search_all` returns. Every column is documented in 0019. */
type SearchRow = {
  kind: string
  id: string
  created_at: string
  total_count: number
  title: string | null
  subtitle: string | null
  slug: string | null
  handle: string | null
  avatar_url: string | null
  category: string | null
  status: string | null
  visibility: string | null
  is_seeking_members: boolean | null
  member_count: number | null
  star_count: number | null
  like_count: number | null
  comment_count: number | null
  upvote_count: number | null
  interest_count: number | null
  starts_at: string | null
  deadline: string | null
  author_id: string | null
  author_username: string | null
  author_display_name: string | null
  author_avatar_url: string | null
  author_headline: string | null
}

function author(row: SearchRow): ProfileSummary | null {
  if (!row.author_id || !row.author_username || !row.author_display_name) return null
  return {
    id: row.author_id,
    username: row.author_username,
    display_name: row.author_display_name,
    avatar_url: row.author_avatar_url,
    headline: row.author_headline,
  }
}

/**
 * One row, narrowed to its kind.
 *
 * `null` for a row this build does not know how to draw — an unknown `kind` from a
 * newer database, or a person row without the username its link needs. Dropping it
 * is the honest option: rendering an unnamed card or a link to `/u/null` would be
 * worse than one result fewer, and the count is what the function counted either
 * way, so the page says "one fewer than shown" only in a case that cannot happen
 * with matching code on both sides.
 */
function toResult(row: SearchRow): SearchResult | null {
  switch (row.kind) {
    case 'person':
      if (!row.handle || !row.title) return null
      return {
        kind: 'person',
        id: row.id,
        created_at: row.created_at,
        person: {
          id: row.id,
          username: row.handle,
          display_name: row.title,
          avatar_url: row.avatar_url,
          headline: row.subtitle,
        },
      }

    case 'project':
      if (!row.slug || !row.title) return null
      return {
        kind: 'project',
        id: row.id,
        created_at: row.created_at,
        project: {
          id: row.id,
          slug: row.slug,
          title: row.title,
          tagline: row.subtitle,
          category: row.category ?? 'other',
          status: row.status ?? 'planning',
          visibility: row.visibility ?? 'public',
          is_seeking_members: row.is_seeking_members ?? false,
          member_count: row.member_count ?? 0,
          star_count: row.star_count ?? 0,
          created_at: row.created_at,
          owner: author(row),
        },
      }

    case 'post':
      return {
        kind: 'post',
        id: row.id,
        created_at: row.created_at,
        post: {
          id: row.id,
          title: row.title,
          excerpt: row.subtitle,
          type: row.category ?? 'text',
          like_count: row.like_count ?? 0,
          comment_count: row.comment_count ?? 0,
          created_at: row.created_at,
          author: author(row),
        },
      }

    case 'idea':
      if (!row.title) return null
      return {
        kind: 'idea',
        id: row.id,
        created_at: row.created_at,
        idea: {
          id: row.id,
          title: row.title,
          excerpt: row.subtitle,
          category: row.category ?? 'other',
          status: row.status ?? 'open',
          upvote_count: row.upvote_count ?? 0,
          interest_count: row.interest_count ?? 0,
          created_at: row.created_at,
          author: author(row),
        },
      }

    case 'opportunity':
      if (!row.slug || !row.title) return null
      return {
        kind: 'opportunity',
        id: row.id,
        created_at: row.created_at,
        opportunity: {
          id: row.id,
          slug: row.slug,
          title: row.title,
          organisation: row.subtitle,
          type: row.category ?? 'other',
          status: row.status ?? 'open',
          deadline: row.deadline,
          created_at: row.created_at,
          author: author(row),
        },
      }

    case 'event':
      if (!row.slug || !row.title || !row.starts_at) return null
      return {
        kind: 'event',
        id: row.id,
        created_at: row.created_at,
        event: {
          id: row.id,
          slug: row.slug,
          title: row.title,
          type: row.category ?? 'other',
          location: row.subtitle,
          starts_at: row.starts_at,
          created_at: row.created_at,
          author: author(row),
        },
      }

    default:
      return null
  }
}

/**
 * One page of one kind of result.
 *
 * The cursor is `(created_at, id)` — the shape `src/lib/cursor.ts` encodes — and
 * only its `id` is sent to the function. The third part of the sort key, the
 * boundary row's similarity, is recomputed by the function from that id, in the
 * same statement and with the same expression that ranked the rows. Carrying the
 * score in the cursor would mean trusting a number that arrived from the browser;
 * recomputing it means the boundary cannot drift from the rows it bounds.
 *
 * A cursor that no longer resolves — the row was deleted, hidden, or the cursor was
 * edited — produces an empty boundary and the function returns the first page. That
 * is the safe answer: an ignored cursor shows a page twice at worst, whereas an
 * error page for a stale link is a dead end.
 *
 * The function returns rows already ordered, and PostgREST executes it as
 * `select ... from search_all(...)`, which preserves the function's row order. It is
 * not re-sorted here because the score that ordered it is deliberately not part of
 * the result — see 0019 on why no similarity number is returned.
 */
export async function searchAll({
  query,
  kind = DEFAULT_KIND,
  cursor,
  limit = PAGE_SIZE,
}: {
  query: string
  kind?: SearchKind
  cursor?: string | string[] | undefined
  limit?: number
}): Promise<SearchResultsPage> {
  const decoded = decodeCursor(firstParam(cursor))

  // Checked here as well as in the function, so that a one-character search costs
  // no round trip. The database is still the thing that guarantees it. In local
  // mode this is also what keeps a one-character search from reading the store.
  if (query.length < MIN_QUERY_LENGTH) {
    return { results: [], total: 0, nextCursor: null, error: null }
  }

  if (isLocalMode()) return localSearchAll({ query, kind, cursor, limit })

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('search_all', {
    p_query: query,
    p_kind: kind,
    p_after_id: decoded?.id ?? null,
    p_limit: limit,
  })

  if (error) {
    // Logged in full, reported as a sentence: a PostgREST error message names
    // tables, columns and sometimes constraint text, which is a free schema map.
    console.error('[search:searchAll]', error.code, error.message)
    return {
      results: null,
      total: null,
      nextCursor: null,
      error: 'The search could not be run. Please try again.',
    }
  }

  // `search_all` is a plpgsql function, so the generated types only know it as
  // `Record<string, unknown>[]`. The shape it actually returns is fixed by the
  // migration's RETURNS TABLE; the cast is where that promise is made in TypeScript.
  // A `.returns<SearchRow[]>()` cast cannot be used here: postgrest-js refuses to
  // cast an object row to an array type, so the widening happens on the value.
  const rows = (data ?? []) as unknown as SearchRow[]
  const results = rows
    .map(toResult)
    .filter((result): result is SearchResult => result !== null)
  const last = rows.at(-1)

  return {
    results,
    // The count the function computed, carried on every row. With no rows and a
    // cursor, "no rows" means "past the end", not "none matched", so the count is
    // left unknown rather than reported as zero.
    total: rows[0] ? rows[0].total_count : decoded ? null : 0,
    // A full page means there may be more; a short page is the real end of the
    // list, which is what `EndOfList` renders instead of an endless spinner.
    nextCursor:
      rows.length === limit && last ? { createdAt: last.created_at, id: last.id } : null,
    error: null,
  }
}

// =============================================================================
// Local mode
// =============================================================================
//
// `public.search_all` transcribed over `data/local.json`. The branches, the
// filters, the ordering and the count are the function's; the visibility each
// branch would get from RLS is asked of the feature that owns the row, so a
// private project stays private by the same code that hides it everywhere else.
//
// WHAT IS GENUINELY DIFFERENT
// ---------------------------
// 1. **The score.** Postgres orders by `extensions.similarity(column, query)` — a
//    pg_trgm measurement of two strings. There is no trigram index in a JSON file
//    and no portable equivalent in TypeScript, so the ranking here is the two-tier
//    reading of the same idea: a row whose searched text *starts with* the query
//    ranks above a row that merely *contains* it, and inside a tier the order is
//    `created_at desc, id desc` — the tiebreak the migration already uses. What is
//    lost is fuzzy matching (the `%` operator's typo tolerance: `ayesah` no longer
//    finds `ayesha`) and the ordering *within* a tier, which becomes recency.
//    What is not lost is the match set: the migration ORs `%` with
//    `ILIKE '%query%'`, and the ILIKE half is a literal case-insensitive substring
//    test — which is exactly `includes` on a lowercased string, because the
//    migration escapes `%` and `_` before they reach the pattern.
// 2. **The counters.** `member_count` and a post's like/comment counts are counted
//    from `project_members`, `post_likes` and `comments`, because nothing maintains
//    the cached columns locally. `star_count` is 0 — there is no `project_stars`
//    table in the store, so zero is the true number. Idea upvotes and interest keep
//    their stored values for the same reason in reverse: there is no `idea_votes`
//    table to count.
// 3. **`headline`, `type`, `slug`.** The store has no `profiles.headline` (the
//    department stands in, as in features/feed), no `events.type` (reported as
//    `other`, as in features/events, because nothing in the row says otherwise),
//    and no `slug` on opportunities or events (derived by the owning feature's own
//    derivation, so a result carries the slug its detail route answers).
//
// Case folding is `toLowerCase()` in both halves. Diacritics are *not* stripped:
// the migration does not enable `unaccent`, so `café` does not match `cafe` there
// and must not match here. The one honest gap is that JS and Postgres case-fold a
// handful of non-ASCII code points differently.

/** The function's RETURNS TABLE, minus `total_count`, which is per result set. */
type SearchRowFields = Omit<SearchRow, 'total_count'>

/** Prefix rank. Lower is better, and the sort is ascending on it. */
const PREFIX_TIER = 0

/** Contains rank: a match, but below every prefix match. */
const CONTAINS_TIER = 1

/** `least(greatest(coalesce(p_limit, 20), 1), 50)` from the migration's params CTE. */
const MAX_PAGE_SIZE = 50

/** One match, with the rank it will be ordered by. */
type LocalMatch = {
  row: SearchRowFields
  /** `PREFIX_TIER` or `CONTAINS_TIER`; the local stand-in for `relevance`. */
  tier: number
}

/**
 * Every column the function does not return for a kind is null — the same thing
 * the migration's `null::text`, `null::integer` and `null::uuid` casts do, and the
 * mapper's `?? 0` defaults then read as "this kind has no such number".
 */
function blankRow(kind: string, id: string, created_at: string): SearchRowFields {
  return {
    kind,
    id,
    created_at,
    title: null,
    subtitle: null,
    slug: null,
    handle: null,
    avatar_url: null,
    category: null,
    status: null,
    visibility: null,
    is_seeking_members: null,
    member_count: null,
    star_count: null,
    like_count: null,
    comment_count: null,
    upvote_count: null,
    interest_count: null,
    starts_at: null,
    deadline: null,
    author_id: null,
    author_username: null,
    author_display_name: null,
    author_avatar_url: null,
    author_headline: null,
  }
}

/**
 * The four author columns, from a profile.
 *
 * `left join public.profiles` is filtered by `profiles_select` like any other read,
 * so an author the reader may not see arrives as four nulls and the card says
 * "author not visible to you" — the same answer the Supabase join gives. A missing
 * profile (deleted, or never created) is the same four nulls.
 */
function withAuthor(
  row: SearchRowFields,
  profile: LocalProfile | undefined,
  viewer: LocalViewer,
): SearchRowFields {
  if (!profile || !canViewLocalProfile(profile, viewer)) return row

  return {
    ...row,
    author_id: profile.id,
    author_username: profile.username,
    author_display_name: profile.display_name,
    author_avatar_url: profile.avatar_url,
    // No `headline` column in the store; the department is the stored affiliation
    // the row has room for, which is what features/feed does with the same gap.
    author_headline: profile.department,
  }
}

/**
 * `PREFIX_TIER`, `CONTAINS_TIER`, or `null` for no match.
 *
 * The needle is already trimmed and folded. A person is matched on two columns and
 * the migration takes `greatest(similarity(display_name), similarity(username))`,
 * so a prefix in either column outranks a contains in the other — which is what
 * returning as soon as a prefix is found does.
 */
function matchTier(haystacks: readonly (string | null)[], needle: string): number | null {
  let tier: number | null = null

  for (const haystack of haystacks) {
    if (!haystack) continue
    const folded = haystack.toLowerCase()
    if (folded.startsWith(needle)) return PREFIX_TIER
    if (tier === null && folded.includes(needle)) tier = CONTAINS_TIER
  }

  return tier
}

/**
 * `order by relevance desc, created_at desc, id desc`, with the tier standing in
 * for relevance. `id` last is not decoration: `created_at` alone is not unique, so
 * without it the order is not total and a cursor can land between two rows and
 * repeat one for ever.
 */
function compareMatches(a: LocalMatch, b: LocalMatch): number {
  if (a.tier !== b.tier) return a.tier - b.tier

  const left = Date.parse(a.row.created_at)
  const right = Date.parse(b.row.created_at)
  if (left !== right) return right - left

  return a.row.id < b.row.id ? 1 : a.row.id > b.row.id ? -1 : 0
}

/**
 * Strictly below the boundary in `compareMatches` order — the migration's
 *
 *     (relevance, created_at, id) < (boundary.relevance, boundary.created_at, boundary.id)
 *
 * with the boundary row's rank recomputed here rather than carried in the cursor,
 * so the two sides can never disagree about it.
 */
function isBelowBoundary(candidate: LocalMatch, boundary: LocalMatch): boolean {
  if (candidate.tier !== boundary.tier) return candidate.tier > boundary.tier

  const time = Date.parse(candidate.row.created_at)
  const edge = Date.parse(boundary.row.created_at)
  if (time !== edge) return time < edge

  return candidate.row.id < boundary.row.id
}

/**
 * `ideas_select` / `app.can_view_idea`, in TypeScript.
 *
 * This is the body of `canSeeIdea` in `features/ideas/queries`, which is
 * module-private. The order matters and is the policy's: `deleted_at` first, then
 * the author (who is admitted regardless of visibility), then the switch.
 *
 * `connections` collapses to "author only": the local store has no connections
 * table, so nobody is connected to anybody, and broadening it to "everyone" would
 * publish ideas their authors wrote for a smaller audience.
 */
function localCanSeeIdea(db: Tables, idea: LocalIdea, reader: LocalProfile | null): boolean {
  if (idea.deleted_at) return false
  if (reader && idea.author_id === reader.id) return true

  switch (idea.visibility) {
    case 'public':
      return true
    case 'university': {
      const author = db.profiles.find((profile) => profile.id === idea.author_id)
      return Boolean(
        reader?.university_id && author?.university_id && author.university_id === reader.university_id,
      )
    }
    case 'connections':
    case 'private':
    default:
      return false
  }
}

/**
 * One branch per kind, exactly the six `union all` branches of the function.
 *
 * Each starts with the two filters the migration applies to every reader,
 * `deleted_at is null` and `moderation_status = 'active'`, because those are not
 * access-control questions — the policies deliberately leave a hidden row readable
 * so a moderator can review it, and search is not the moderation queue. Where the
 * store has no such column there is nothing to check: `moderation_status` exists on
 * posts only, and profiles have neither.
 *
 * The visibility call after it is the branch's RLS, delegated to the feature that
 * owns the predicate. `blocks` is absent for the same reason `connections` is:
 * neither table exists locally, so nobody is blocked and nobody is connected.
 */
function localMatches(
  db: Tables,
  kind: SearchKind,
  needle: string,
  reader: LocalProfile | null,
  viewer: LocalViewer,
): LocalMatch[] {
  const matches: LocalMatch[] = []
  const profileOf = (profileId: string | null) =>
    profileId ? db.profiles.find((profile) => profile.id === profileId) : undefined

  switch (kind) {
    case 'person': {
      for (const profile of db.profiles) {
        if (!profile.searchable) continue
        if (!canViewLocalProfile(profile, viewer)) continue

        const tier = matchTier([profile.display_name, profile.username], needle)
        if (tier === null) continue

        matches.push({
          tier,
          row: {
            ...blankRow('person', profile.id, profile.created_at),
            title: profile.display_name,
            subtitle: profile.department,
            handle: profile.username,
            avatar_url: profile.avatar_url,
            visibility: profile.visibility,
          },
        })
      }
      break
    }

    case 'project': {
      for (const project of db.projects) {
        if (project.deleted_at !== null) continue
        if (!canSeeProject(db, project, reader)) continue

        const tier = matchTier([project.title], needle)
        if (tier === null) continue

        matches.push({
          tier,
          row: withAuthor(
            {
              ...blankRow('project', project.id, project.created_at),
              title: project.title,
              // `projects.purpose` is the store's tagline slot; the card renders it
              // under the title, which is the column the migration returns.
              subtitle: project.purpose,
              slug: project.slug,
              category: project.category,
              status: project.status,
              visibility: project.visibility,
              is_seeking_members: project.is_seeking_members,
              // Counted from the membership rows, never the cached column: no
              // trigger maintains it in this mode.
              member_count: db.project_members.filter((member) => member.project_id === project.id)
                .length,
              // `star_count` stays null: the store has no `project_stars` table, so
              // zero is the true number and the mapper's `?? 0` is where it is said.
            },
            profileOf(project.owner_id),
            viewer,
          ),
        })
      }
      break
    }

    case 'post': {
      for (const post of db.posts) {
        if (post.deleted_at !== null) continue
        if (post.moderation_status !== 'active') continue

        const author = profileOf(post.author_id)
        if (!localCanViewPost(post, reader, author)) continue

        const tier = matchTier([post.body], needle)
        if (tier === null) continue

        matches.push({
          tier,
          row: withAuthor(
            {
              ...blankRow('post', post.id, post.created_at),
              // `left(btrim(coalesce(body, '')), 200)`.
              subtitle: post.body.trim().slice(0, 200),
              // No `type` column locally; derived from the attachment by the same rule
              // `createPostAction` applies on insert, as features/feed does.
              category: post.project_id
                ? 'project_update'
                : post.goal_id
                  ? 'learning_update'
                  : 'text',
              visibility: post.visibility,
              like_count: db.post_likes.filter((like) => like.post_id === post.id).length,
              comment_count: db.comments.filter(
                (comment) => comment.post_id === post.id && comment.deleted_at === null,
              ).length,
            },
            author,
            viewer,
          ),
        })
      }
      break
    }

    case 'idea': {
      for (const idea of db.ideas) {
        if (idea.deleted_at !== null) continue
        if (!localCanSeeIdea(db, idea, reader)) continue

        const tier = matchTier([idea.title], needle)
        if (tier === null) continue

        matches.push({
          tier,
          row: withAuthor(
            {
              ...blankRow('idea', idea.id, idea.created_at),
              title: idea.title,
              // `left(btrim(description), 200)`.
              subtitle: idea.description.trim().slice(0, 200),
              category: idea.category,
              status: idea.status,
              visibility: idea.visibility,
              // Stored, because the store has no `idea_votes` or `idea_interest`
              // table: there are no rows to count, and the column is all there is.
              upvote_count: idea.upvote_count,
              interest_count: idea.interest_count,
            },
            profileOf(idea.author_id),
            viewer,
          ),
        })
      }
      break
    }

    case 'opportunity': {
      for (const opportunity of db.opportunities) {
        if (opportunity.deleted_at !== null) continue
        if (!canViewOpportunity(db, opportunity, reader)) continue

        const tier = matchTier([opportunity.title], needle)
        if (tier === null) continue

        matches.push({
          tier,
          row: withAuthor(
            {
              ...blankRow('opportunity', opportunity.id, opportunity.created_at),
              title: opportunity.title,
              subtitle: opportunity.organisation,
              // No `slug` column: derived by the owner of the derivation, so the
              // result carries the slug `/opportunities/[slug]` answers.
              slug: localOpportunitySlug(db, opportunity.id),
              category: opportunity.type,
              status: opportunity.status,
              visibility: opportunity.visibility,
              deadline: opportunity.deadline,
            },
            profileOf(opportunity.posted_by),
            viewer,
          ),
        })
      }
      break
    }

    case 'event': {
      for (const event of db.events) {
        if (event.deleted_at !== null) continue
        if (!canViewEvent(db, event, reader)) continue

        const tier = matchTier([event.title], needle)
        if (tier === null) continue

        matches.push({
          tier,
          row: withAuthor(
            {
              ...blankRow('event', event.id, event.created_at),
              title: event.title,
              subtitle: event.location,
              slug: localEventSlug(db, event.id),
              // No `type` column, and nothing in the row that implies one. `other`
              // is a real value of the CHECK, and features/events reports the same
              // constant for the same reason.
              category: 'other',
              status: event.status,
              visibility: event.visibility,
              starts_at: event.starts_at,
            },
            profileOf(event.created_by),
            viewer,
          ),
        })
      }
      break
    }

    default:
      // Unreachable for a SearchKind, and empty rather than throwing: an unknown
      // kind from a hand-edited URL is a blank tab, which is what the function
      // returns for a `p_kind` that matches no branch.
      break
  }

  return matches
}

/**
 * Decode a cursor against the store's own id scheme.
 *
 * `decodeCursor` insists the id half is a uuid, because a uuid is what Postgres
 * mints and anything else is a tampered or truncated cursor. The local store mints
 * `<prefix>_<base36>` ids (see `id()` in `@/lib/local/db`), so that guard rejects
 * every cursor this file issues — `pst_…` is not a uuid — and page two would
 * silently render page one for ever. The encoding and the shape are unchanged:
 * base64url over `created_at|id`, with the timestamp still validated. Only the
 * id's shape is checked against the store's scheme rather than Postgres's.
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
  const cursorId = decoded.slice(separator + 1)

  if (!cursorId) return null
  if (Number.isNaN(Date.parse(createdAt))) return null

  return { createdAt, id: cursorId }
}

/**
 * `searchAll` against the store.
 *
 * The shape of the answer is the Supabase path's, including the two places the
 * count is not a number: `total` is the size of the whole match set on every page
 * that has a row to carry it, `null` on a page fetched with a cursor that came back
 * empty (there is nothing to carry it, and "past the end" is not "none matched"),
 * and `0` when there was no cursor and nothing matched.
 *
 * A cursor whose id is not in this kind's match set — deleted, hidden, or edited —
 * resolves to no boundary and the first page is returned, which is what the
 * function does. `nextCursor` is only produced for a full page, so the page renders
 * `EndOfList` at the real end rather than an endless spinner.
 */
async function localSearchAll({
  query,
  kind,
  cursor,
  limit,
}: {
  query: string
  kind: SearchKind
  cursor?: string | string[] | undefined
  limit: number
}): Promise<SearchResultsPage> {
  const needle = query.trim().toLowerCase()

  // The same guard as `searchAll`, repeated here so this function is safe to call
  // on its own. It is before the store read on purpose.
  if (needle.length < MIN_QUERY_LENGTH) {
    return { results: [], total: 0, nextCursor: null, error: null }
  }

  // `getUser()` first: it writes the seed on a fresh clone, so a store read after
  // it has something in it.
  const user = await getUser()
  const db = await readStore()
  const reader = user ? (db.profiles.find((profile) => profile.user_id === user.id) ?? null) : null
  const viewer = localViewer(db, user?.id ?? null)

  const decoded = decodeLocalCursor(cursor)
  const matches = localMatches(db, kind, needle, reader, viewer).sort(compareMatches)

  // The boundary is looked up by id in the match set, not in the whole table: a row
  // that is not a visible match for this query cannot bound it.
  const boundary = decoded ? matches.find((match) => match.row.id === decoded.id) : undefined
  const page = (boundary ? matches.filter((match) => isBelowBoundary(match, boundary)) : matches).slice(
    0,
    // The function clamps to 1..50; a caller asking for more gets 50 rows and, as in
    // the Supabase path, no next cursor, because the page it got is shorter than the
    // limit it asked for.
    Math.min(Math.max(limit, 1), MAX_PAGE_SIZE),
  )

  const rows: SearchRow[] = page.map((match) => ({ ...match.row, total_count: matches.length }))
  const results = rows
    .map(toResult)
    .filter((result): result is SearchResult => result !== null)
  const last = rows.at(-1)

  return {
    results,
    total: rows[0] ? rows[0].total_count : decoded ? null : 0,
    nextCursor:
      rows.length === limit && last ? { createdAt: last.created_at, id: last.id } : null,
    error: null,
  }
}
