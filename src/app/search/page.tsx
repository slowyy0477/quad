import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { EndOfList, LoadMore, cursorHref } from '@/components/ui/pagination'
import { SearchInput } from '@/components/ui/search-input'
import { EmptyState, SectionHeading } from '@/components/ui/surface'
import { encodeCursor } from '@/lib/cursor'
import { isSupabaseConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'
import { ResultSummary, SearchResults } from '@/features/search/components/search-results'
import { SearchTabs } from '@/features/search/components/search-tabs'
import {
  MIN_QUERY_LENGTH,
  SEARCH_KIND_SPECS,
  kindSpec,
  parseKind,
  parseQuery,
  searchAll,
} from '@/features/search/queries'

export const metadata: Metadata = { title: 'Search' }

type SearchParams = Record<string, string | string[] | undefined>

/**
 * The three things a reader who found nothing can usefully do next.
 *
 * One component, used by every empty state on the page, because three different
 * empty states drifting into three different sets of suggestions is how a page
 * stops teaching anything about itself.
 */
function NextMoves() {
  const moves = [
    { href: '/feed/people', label: 'People at your university' },
    { href: '/projects?lens=open', label: 'Projects open to join' },
    { href: '/universities', label: 'The institution directory' },
  ]

  return (
    <ul className="mt-2 space-y-1">
      {moves.map((move) => (
        <li key={move.href}>
          <Link href={move.href} className="text-accent-700 underline underline-offset-2">
            {move.label}
          </Link>
        </li>
      ))}
    </ul>
  )
}

/**
 * Search.
 *
 * One field, six kinds of result, and every number on the page is a row.
 *
 * The field is `SearchInput` — a GET form, so a search is a URL that can be shared,
 * bookmarked, reloaded and reached with the back button, and the page works before
 * any JavaScript loads. Its target is `/search` with a `q` parameter, which is the
 * address this page reads. One consequence worth naming: the form carries only `q`,
 * so submitting a new query from a non-default tab returns the reader to the
 * default tab. Carrying the tab would mean a hidden input in the form, and the form
 * is a shared primitive this feature does not own.
 *
 * **The kind is in the URL** (`?tab=project`), so a tab is linkable. **The cursor is
 * in the URL too**, and it is opaque (base64url over `created_at|id`), so a reader
 * cannot usefully edit it and a truncated share decodes to nothing — `decodeCursor`
 * fails closed and the first page is shown, which is a better answer than an error
 * page for what is usually a typo. A cursor whose row has since been deleted or
 * hidden is ignored the same way, by the function rather than here.
 *
 * **A session is required.** proxy.ts does not gate this route — search is not in its
 * private prefixes — so this check is the gate rather than a belt-and-braces
 * repeat of one. It is not an interface decision: `public.search_all` is granted to
 * `authenticated` and nobody else, because every result is filtered by a reader's own
 * visibility rules and a signed-out visitor has none. The destination is carried
 * through, so signing in lands on the search that was asked for.
 *
 * Four states, and the two empty ones say different things: no query yet is a page
 * explaining what is searchable, and a query that matched nothing is a page saying
 * what it looked at. They are not the same message and they do not get the same copy.
 */
export default async function SearchPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  if (!isSupabaseConfigured()) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-12">
        <h1 className="text-2xl">Search</h1>
        <Alert tone="warning" title="No database connected" className="mt-5">
          <p>
            Search reads rows from Postgres. Without Supabase credentials there is nothing to look
            through, and this page will not show made-up results in their place.{' '}
            <Link href="/setup">Configuration steps</Link>.
          </p>
        </Alert>
      </div>
    )
  }

  const params = await searchParams
  const query = parseQuery(params.q)
  const kind = parseKind(params.tab)

  const user = await getUser()
  if (!user) {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue
      if (Array.isArray(value)) value.forEach((item) => search.append(key, item))
      else search.set(key, value)
    }
    const wanted = search.toString() ? `/search?${search}` : '/search'
    redirect(`/login?next=${encodeURIComponent(wanted)}`)
  }

  const spec = kindSpec(kind)
  const { results, total, nextCursor, error } = await searchAll({
    query,
    kind,
    cursor: params.cursor,
  })

  // Switching kind drops the cursor: a cursor is a position in one ordering, and
  // carrying it to another list would land the reader in the middle of a page they
  // never scrolled.
  const tabs = SEARCH_KIND_SPECS.map((candidate) => ({
    value: candidate.kind,
    label: candidate.label,
    href: cursorHref('/search', { ...params, tab: candidate.kind }, null),
  }))

  const loadMoreHref = nextCursor
    ? cursorHref('/search', { ...params, tab: kind }, encodeCursor(nextCursor))
    : null

  const tooShort = query.length > 0 && query.length < MIN_QUERY_LENGTH

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
      <SectionHeading
        title="Search"
        description="People, projects, posts, ideas, opportunities and events, in one place."
      />

      {/* `key` on the query, so the field shows the query the URL actually searched
          after a submit rather than whatever was last typed into it. */}
      <SearchInput key={query} defaultValue={query} className="mt-5" />

      <div className="mt-6">
        <SearchTabs value={kind} tabs={tabs}>
          {error ? (
            <Alert tone="danger">{error}</Alert>
          ) : results === null ? null : query.length === 0 ? (
            <EmptyState title="Search Quad">
              <p>
                Type a name, a project, or a word from a post. Search looks at display names and
                usernames, project titles, post text, idea titles, opportunity titles and event
                titles.
              </p>
              <p className="mt-2">Not sure where to start?</p>
              <NextMoves />
            </EmptyState>
          ) : tooShort ? (
            <EmptyState title="One more character">
              <p>
                Matching is by trigram — three letters at a time — so a single character has nothing
                to match against. Two characters is the shortest useful search.
              </p>
            </EmptyState>
          ) : results.length === 0 ? (
            <EmptyState title={`No ${spec.plural} match “${query}”`}>
              <p>
                This tab looks at {spec.matches}. It does not search taglines, descriptions,
                biographies or messages, so a word that appears only there will not match. Names
                that resemble what you typed are included, not just exact ones.
              </p>
              <p className="mt-2">Try a shorter word, another tab, or start from:</p>
              <NextMoves />
            </EmptyState>
          ) : (
            <div className="space-y-4">
              {total !== null ? (
                <ResultSummary
                  count={total}
                  singular={spec.singular}
                  plural={spec.plural}
                  query={query}
                />
              ) : null}

              <SearchResults results={results} />

              {loadMoreHref ? <LoadMore href={loadMoreHref} /> : <EndOfList />}
            </div>
          )}
        </SearchTabs>
      </div>

      <p className="mt-8 text-xs text-ink-faint">
        Search runs inside Postgres, so it returns the rows you are allowed to see and nothing else:
        a private project, a blocked account, a hidden post and a profile that has opted out of
        search are all excluded before the results reach this page.{' '}
        <Link href="/status" className="text-accent-700 underline underline-offset-2">
          Build status
        </Link>
        .
      </p>
    </div>
  )
}
