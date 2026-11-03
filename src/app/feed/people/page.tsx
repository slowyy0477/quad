import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { EmptyState, SectionHeading } from '@/components/ui/surface'
import { EndOfList, LoadMore } from '@/components/ui/pagination'
import { isDataConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'
import { getMyUniversityId } from '@/features/universities/queries'
import { PeopleFilterForm } from '@/features/search/components/people-filters'
import { PeopleResults } from '@/features/search/components/people-results'
import { firstValue, parsePeopleFilters, peopleHref, type DiscoveryParams } from '@/features/search/filters'
import { discoverPeople, listDiscoveryUniversities } from '@/features/search/people'

export const metadata: Metadata = { title: 'People at your university' }

/** Starts at the reader's institution, with explicit URL filters and bounded pages. */
export default async function FeedPeoplePage({
  searchParams,
}: { searchParams: Promise<DiscoveryParams> }) {
  if (!isDataConfigured()) {
    return (
      <div className="page-enter mx-auto w-full max-w-2xl px-4 py-12">
        <h1 className="text-2xl">People at your university</h1>
        <Alert tone="warning" title="No database connected" className="mt-5">
          <p>
            People discovery needs a configured data provider. No profiles are invented.{' '}
            <Link href="/help">Get help</Link>.
          </p>
        </Alert>
      </div>
    )
  }

  const params = await searchParams
  const user = await getUser()
  if (!user) {
    const wanted = peopleHref(parsePeopleFilters(params), firstValue(params.cursor), '/feed/people')
    redirect(`/login?next=${encodeURIComponent(wanted)}`)
  }
  const [myUniversityId, picker] = await Promise.all([getMyUniversityId(), listDiscoveryUniversities()])
  const filters = parsePeopleFilters(params)
  if (params.university === undefined) filters.universityId = myUniversityId
  const { people, nextCursor, error } = await discoverPeople({
    ...filters, cursor: params.cursor, excludeSelf: true,
  })

  return (
    <div className="page-enter mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl text-ink">Find people</h1>
      <SectionHeading
        title={filters.universityId ? 'People at this institution' : 'Across the Bulla community'}
        description="Filter by institution, department and self-declared skills. Open a profile to follow or connect."
      />

      <p className="mt-2 text-xs text-ink-faint">
        <Link href="/feed" className="text-accent-700 underline underline-offset-2">
          Back to the feed
        </Link>
      </p>

      <div className="mt-6">
        <PeopleFilterForm filters={filters} universities={picker.universities}
          action="/feed/people" hasMoreUniversities={picker.hasMore} />
        {picker.error ? <Alert tone="warning" className="mt-3">{picker.error}</Alert> : null}
      </div>

      {error ? (
        <Alert tone="danger" className="mt-6">
          {error}
        </Alert>
      ) : null}

      {myUniversityId === null ? (
        <p className="mt-4 text-sm text-ink-muted">
          Your profile has no institution yet. You can still browse, or{' '}
            <Link href="/universities" className="text-accent-700 underline underline-offset-2">
              choose your institution
            </Link>
          .
        </p>
      ) : null}

      {!error && people?.length === 0 ? (
        <EmptyState title={firstValue(params.cursor)
          ? 'No further readable people in this view' : 'No readable profiles match this view'} className="mt-6">
          <p>
            Clear a department or skill filter, or browse across universities. Only readable
            profiles that opted into discovery appear here; private and unlisted accounts are
            not described by this result.
          </p>
          <Link href="/feed/people?university=" className="mt-3 inline-block text-accent-700 underline">
            Browse all universities
          </Link>
        </EmptyState>
      ) : null}

      {people && people.length > 0 ? (
        <div className="mt-6">
          <p role="status" className="text-xs text-ink-faint">
            Showing {people.length} readable profiles on this page, ordered by profile creation.
          </p>
          <PeopleResults people={people} />
          {nextCursor ? (
            <LoadMore href={peopleHref(filters, nextCursor, '/feed/people')} label="Next people" />
          ) : <EndOfList label="No further readable profiles in this view." />}
        </div>
      ) : null}
    </div>
  )
}
