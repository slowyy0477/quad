import Link from 'next/link'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { EndOfList, LoadMore, cursorHref } from '@/components/ui/pagination'
import { EmptyState, SectionHeading } from '@/components/ui/surface'
import { todayInPakistan } from '@/features/opportunities/board'
import { BoardFilters } from '@/features/opportunities/components/board-filters'
import { BoardLenses } from '@/features/opportunities/components/board-lenses'
import { OpportunityRow } from '@/features/opportunities/components/opportunity-row'
import {
  listClosedOpportunities,
  listOpenOpportunities,
  type OpportunityPage,
} from '@/features/opportunities/queries'
import { isSupabaseConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'

export const metadata: Metadata = { title: 'Opportunities' }

type SearchParams = Record<string, string | string[] | undefined>

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * Opportunities: two lenses over the same rows.
 *
 * "Open" is what a reader can still apply for, sorted by closing date because a dated
 * listing is more urgent than an undated one. "Closed" is everything that is no longer
 * open -- closed or filled by its poster, or past its deadline -- sorted newest posted
 * first, because nothing about it is urgent.
 *
 * A closed listing is never deleted from the board or dropped from the database; it moves
 * lens, and the row says which of the two reasons applies. That is the honest treatment of
 * a deadline that has gone by: nothing rewrites `status`, so the interface is where the
 * date becomes a word.
 *
 * Every filter is URL state, so a filtered board is a link someone can send.
 */
export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  if (!isSupabaseConfigured()) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-12">
        <h1 className="text-2xl">Opportunities</h1>
        <Alert tone="warning" title="No database connected" className="mt-5">
          <p>
            Listings are read from Postgres. Without Supabase credentials there is nothing to read, and
            this page will not show invented listings in their place. <Link href="/setup">Configuration steps</Link>.
          </p>
        </Alert>
      </div>
    )
  }

  const params = await searchParams
  const user = await getUser()

  const lens = first(params.lens) === 'closed' ? 'closed' : 'open'
  const type = first(params.type)
  const workMode = first(params.mode)
  const within = first(params.within)

  // One clock for the whole render. Rows read `today` rather than each calling `new
  // Date()`, so a page rendered across midnight cannot label two rows against two days.
  const now = new Date()
  const today = todayInPakistan(now)

  const page: OpportunityPage =
    lens === 'closed'
      ? await listClosedOpportunities({ type, workMode, cursor: params.cursor, now })
      : await listOpenOpportunities({
          type,
          workMode,
          window: within,
          cursor: params.cursor,
          now,
        })

  const filtered = Boolean(type || workMode || (lens === 'open' && within))

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <SectionHeading
        title="Opportunities"
        description="Internships, scholarships, competitions and research placements, posted by students and staff here."
        action={
          user ? (
            <Button asChild variant="primary" size="sm">
              <Link href="/opportunities/new">Post a listing</Link>
            </Button>
          ) : (
            <Button asChild variant="secondary" size="sm">
              <Link href="/login?next=/opportunities/new">Sign in to post</Link>
            </Button>
          )
        }
      />

      <div className="mt-5">
        <BoardLenses
          lens={lens}
          tabs={[
            { value: 'open', label: 'Open' },
            { value: 'closed', label: 'Closed' },
          ]}
        />
      </div>

      <p className="mt-3 text-xs text-ink-muted">
        {lens === 'open'
          ? 'Sorted by closing date, soonest first. Listings with no closing date come last.'
          : 'Sorted by when they were posted, newest first. A listing is here because its poster closed it, or because its closing date has passed — neither removes it.'}
      </p>

      <div className="mt-5">
        <BoardFilters lens={lens} type={type} workMode={workMode} within={lens === 'open' ? within : undefined} />
      </div>

      {page.error ? (
        <Alert tone="danger" className="mt-5">
          {page.error}
        </Alert>
      ) : null}

      {page.opportunities.length === 0 ? (
        <div className="mt-6">
          {filtered ? (
            <EmptyState
              title="Nothing matches those filters"
              action={
                <Button asChild variant="secondary">
                  <Link href={lens === 'closed' ? '/opportunities?lens=closed' : '/opportunities'}>
                    Clear the filters
                  </Link>
                </Button>
              }
            >
              <p>
                No {lens === 'closed' ? 'closed' : 'open'} listing matches that type and place together.
                Widening the filters is the quickest way back to a list.
              </p>
            </EmptyState>
          ) : lens === 'closed' ? (
            <EmptyState title="Nothing has closed yet">
              <p>
                A listing appears here when its closing date passes or the person who posted it closes
                it. Until then it is on the open board.
              </p>
            </EmptyState>
          ) : (
            <EmptyState
              title="No listing is open right now"
              action={
                user ? (
                  <Button asChild variant="primary">
                    <Link href="/opportunities/new">Post the first one</Link>
                  </Button>
                ) : (
                  <Button asChild variant="primary">
                    <Link href="/login?next=/opportunities/new">Sign in to post one</Link>
                  </Button>
                )
              }
            >
              <p>
                Every listing here is submitted by someone on this network — an internship a final-year
                student heard about, a scholarship a lecturer passed on. Nothing is scraped from a job
                board.
              </p>
            </EmptyState>
          )}
        </div>
      ) : (
        <>
          <ul className="mt-5 space-y-4">
            {page.opportunities.map((opportunity) => (
              <li key={opportunity.id}>
                <OpportunityRow opportunity={opportunity} today={today} />
              </li>
            ))}
          </ul>

          {page.nextCursor ? (
            <LoadMore
              href={cursorHref('/opportunities', params, page.nextCursor)}
              label="Load more listings"
            />
          ) : (
            <EndOfList
              label={
                lens === 'open'
                  ? 'That is every open listing.'
                  : 'That is every closed listing on the board.'
              }
            />
          )}
        </>
      )}
    </div>
  )
}
