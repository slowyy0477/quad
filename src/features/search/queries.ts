import 'server-only'

import { decodeCursor, type Cursor } from '@/lib/cursor'
import { createClient } from '@/lib/supabase/server'
import type { ProfileSummary } from '@/features/profiles/queries'
import type { ProjectListItem } from '@/features/projects/queries'

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
 * **There is no visibility filter anywhere in this file**, and that is the same
 * decision the feed and project modules make. The function runs as the reader, so
 * row-level security filters every row inside Postgres: a private project is
 * invisible to a non-member, a blocked reader sees nothing from the blocker or the
 * blocked, a `university`-scoped profile is invisible across institutions, and a
 * profile with `searchable = false` is not in the index of the findable. Repeating
 * any of that here would create a second copy of the rule that an attacker can skip
 * by calling PostgREST directly, and the copy that matters is the one they cannot.
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
  // no round trip. The database is still the thing that guarantees it.
  if (query.length < MIN_QUERY_LENGTH) {
    return { results: [], total: 0, nextCursor: null, error: null }
  }

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
