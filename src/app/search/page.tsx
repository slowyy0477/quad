import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { EndOfList, LoadMore, cursorHref } from '@/components/ui/pagination'
import { SearchInput } from '@/components/ui/search-input'
import { EmptyState, SectionHeading } from '@/components/ui/surface'
import { encodeCursor } from '@/lib/cursor'
import { isDataConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'
import { ResultSummary, SearchResults } from '@/features/search/components/search-results'
import { SearchTabs } from '@/features/search/components/search-tabs'
import { PeopleFilterForm } from '@/features/search/components/people-filters'
import { firstValue, parsePeopleFilters } from '@/features/search/filters'
import { listDiscoveryUniversities } from '@/features/search/people'
import {
  MIN_QUERY_LENGTH,
  SEARCH_KIND_SPECS,
  kindSpec,
  parseKind,
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
    { href: '/feed/people', label: 'Find people, starting at your university' },
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

/** URL-addressed discovery. Canonical type=people; legacy tab=person still works. */
export default async function SearchPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  if (!isDataConfigured()) {
    return (
      <div className="page-enter mx-auto w-full max-w-2xl px-4 py-12">
        <h1 className="text-2xl">Search</h1>
        <Alert tone="warning" title="No database connected" className="mt-5">
          <p>
            Search needs a configured data provider. No profiles or results are invented.{' '}
            <Link href="/setup">Configuration steps</Link>.
          </p>
        </Alert>
      </div>
    )
  }

  const params = await searchParams
  const filters = parsePeopleFilters(params)
  const query = filters.query
  const kind = parseKind(params.type ?? params.tab)

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
  const [{ results, total, nextCursor, error }, picker] = await Promise.all([
    searchAll({ ...filters, kind, cursor: params.cursor }),
    kind === 'person' ? listDiscoveryUniversities()
      : Promise.resolve({ universities: [], hasMore: false, error: null }),
  ])

  // Switching kind drops the cursor: a cursor is a position in one ordering, and
  // carrying it to another list would land the reader in the middle of a page they
  // never scrolled.
  const tabs = SEARCH_KIND_SPECS.map((candidate) => ({
    value: candidate.kind,
    label: candidate.label,
    href: cursorHref('/search', {
      q: query, type: candidate.label.toLowerCase(),
      university: filters.universityId ?? undefined,
      department: filters.department || undefined, skill: filters.skill || undefined,
    }, null),
  }))

  const loadMoreHref = nextCursor
    ? cursorHref('/search', {
      q: query, type: spec.label.toLowerCase(),
      university: filters.universityId ?? undefined,
      department: filters.department || undefined, skill: filters.skill || undefined,
    }, typeof nextCursor === 'string' ? nextCursor : encodeCursor(nextCursor))
    : null

  const tooShort = query.length > 0 && query.length < MIN_QUERY_LENGTH

  return (
    <div className="page-enter mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
      <h1 className="text-3xl text-ink">Search Bulla</h1>
      <SectionHeading title="Find your people and your next project"
        description="Discover people by institution, department and self-declared skills, or browse shared work." />

      {/* `key` on the query, so the field shows the query the URL actually searched
          after a submit rather than whatever was last typed into it. */}
      <div className="mt-5">
        {kind === 'person' ? (
          <PeopleFilterForm filters={filters} universities={picker.universities}
            hasMoreUniversities={picker.hasMore} />
        ) : <SearchInput key={query} defaultValue={query} />}
        {picker.error ? <Alert tone="warning" className="mt-3">{picker.error}</Alert> : null}
      </div>

      <div className="mt-6">
        <SearchTabs value={kind} tabs={tabs}>
          {error ? (
            <Alert tone="danger">{error}</Alert>
          ) : results === null ? null : kind === 'person' && results.length === 0 ? (
            <EmptyState title={firstValue(params.cursor)
              ? 'No further readable people in this view' : 'No readable people match this view'}>
              <p>
                Try clearing a filter or using a shorter department or skill name. This view only
                includes profiles you can read that have opted into discovery; it says nothing
                about private or unlisted accounts.
              </p>
              <p className="mt-2">
                <Link href="/search?type=people" className="text-accent-700 underline">Browse without filters</Link>
              </p>
              <NextMoves />
            </EmptyState>
          ) : kind !== 'person' && query.length === 0 ? (
            <EmptyState title="Search Bulla">
              <p>
                Type a name, a project, or a word from a post. Search looks at display names and
                usernames, project titles, post text, idea titles, opportunity titles and event
                titles.
              </p>
              <p className="mt-2">Not sure where to start?</p>
              <NextMoves />
            </EmptyState>
          ) : kind !== 'person' && tooShort ? (
            <EmptyState title="One more character">
              <p>
                Use at least two characters to search this tab.
              </p>
            </EmptyState>
          ) : results.length === 0 ? (
            <EmptyState title={`No ${spec.plural} match “${query}”`}>
              <p>
                This tab looks at {spec.matches}. Try a shorter term or another tab. Biographies
                and private messages are not searched here.
              </p>
              <p className="mt-2">Try a shorter word, another tab, or start from:</p>
              <NextMoves />
            </EmptyState>
          ) : (
            <div className="space-y-4">
              {kind === 'person' ? (
                <p className="text-xs text-ink-faint" role="status">
                  Showing {results.length} readable {results.length === 1 ? 'profile' : 'profiles'} on this page.
                  Ordered by profile creation, not activity or mastery.
                </p>
              ) : total !== null ? (
                <ResultSummary
                  count={total}
                  singular={spec.singular}
                  plural={spec.plural}
                  query={query}
                />
              ) : null}

              <SearchResults results={results} />

              {loadMoreHref ? <LoadMore href={loadMoreHref} label="Next page" />
                : <EndOfList label="No further readable results in this view." />}
            </div>
          )}
        </SearchTabs>
      </div>

      <p className="mt-8 text-xs text-ink-faint">
        Each item keeps its own permissions. People discovery excludes blocked, unavailable and
        unlisted profiles, and does not return private profile totals. Skill labels are the
        person&apos;s own claims, not verified qualifications.{' '}
        <Link href="/status" className="text-accent-700 underline underline-offset-2">
          Build status
        </Link>
        .
      </p>
    </div>
  )
}
