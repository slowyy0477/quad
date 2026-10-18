import Link from 'next/link'
import type { Metadata } from 'next'
import { Alert } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { SearchInput } from '@/components/ui/search-input'
import { EmptyState, SectionHeading, Surface } from '@/components/ui/surface'
import { ClaimUniversityControl } from '@/features/universities/components/claim-university-control'
import { RequestUniversityForm } from '@/features/universities/components/request-university-form'
import { UniversityRow } from '@/features/universities/components/university-row'
import {
  getMyUniversity,
  listMyPendingSubmissions,
  searchUniversities,
} from '@/features/universities/queries'
import { isSupabaseConfigured } from '@/lib/env'
import { getUser } from '@/lib/supabase/server'

export const metadata: Metadata = { title: 'Universities' }

type SearchParams = { q?: string | string[] }

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? ''
  return value ?? ''
}

/**
 * The institution directory.
 *
 * Two things this page is careful about.
 *
 * **It is not a complete list, and it says so.** Migration 0017 seeds a starting
 * set of real institutions; everything else goes through the submission form at
 * the bottom of this page, which files a `pending` row for a moderator. Copy that
 * implied completeness would be a claim the data does not support.
 *
 * **Every number on it is stored.** `student_count` and `project_count` are
 * columns maintained by triggers — one per profile, one per project — so a row
 * here and the same institution anywhere else cannot disagree. Nothing on this
 * page is a `count(*)`, and nothing is rounded to "1.2k".
 *
 * The search is a server-side filter over name, short name and city: the query
 * string is the state, so a result is a URL that can be shared, reloaded and
 * reached with the back button.
 */
export default async function UniversitiesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const q = firstValue(params.q).slice(0, 120)

  if (!isSupabaseConfigured()) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-12">
        <h1 className="text-3xl">Universities</h1>
        <Alert tone="warning" title="No database connected" className="mt-5">
          <p>
            The directory is rows in Postgres. Without Supabase credentials there is nothing to
            list, and this page will not invent institutions in their place.{' '}
            <Link href="/setup">Configuration steps</Link>.
          </p>
        </Alert>
      </div>
    )
  }

  const user = await getUser()
  const signedIn = Boolean(user)

  const [search, mine, pending] = await Promise.all([
    searchUniversities({ q }),
    getMyUniversity(),
    signedIn ? listMyPendingSubmissions() : Promise.resolve([]),
  ])

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl">Universities</h1>
      <p className="mt-2 max-w-prose text-ink-muted">
        Quad holds institutions people have asked for, and marking yours is how you find the other
        students there. The list is not complete — it starts with a set of real universities and
        grows as people file the ones missing from it.
      </p>

      <div className="mt-6">
        <SearchInput
          action="/universities"
          defaultValue={q}
          placeholder="Search by name, short name or city"
        />
      </div>

      {mine ? (
        <Surface className="mt-6 p-4">
          <h2 className="text-2xs font-semibold tracking-[0.12em] text-ink-faint uppercase">
            Your university
          </h2>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-ink">{mine.name}</p>
              <p className="text-xs text-ink-muted">
                {[mine.city, mine.country].filter(Boolean).join(', ')}
              </p>
            </div>
            <ClaimUniversityControl
              universityId={mine.id}
              universityName={mine.name}
              isMine
              signedIn
              allowLeave
            />
          </div>
        </Surface>
      ) : null}

      {search.error ? (
        <Alert tone="danger" className="mt-6">
          {search.error}
        </Alert>
      ) : null}

      <section className="mt-10">
        <SectionHeading
          title={q ? `Institutions matching “${q}”` : 'All institutions'}
          description={
            search.truncated
              ? 'Only the first 60 matches are shown. Search to narrow the list.'
              : undefined
          }
        />

        {search.universities.length > 0 ? (
          <ul className="divide-y divide-hairline border-t border-hairline">
            {search.universities.map((university) => (
              <UniversityRow
                key={university.id}
                university={university}
                isMine={university.id === search.myUniversityId}
                signedIn={signedIn}
              />
            ))}
          </ul>
        ) : (
          <EmptyState title={q ? `No institution matches “${q}”` : 'No institutions are listed yet'}>
            <p>
              {q
                ? 'Nothing in the directory matches that search. It may not have been filed yet — the form below sends it to a moderator.'
                : 'This deployment has no institutions approved yet. File one below and a moderator will look at it.'}
            </p>
            <p className="mt-2">
              <Link href="#request" className="text-accent-700 underline underline-offset-2">
                File an institution
              </Link>
            </p>
          </EmptyState>
        )}
      </section>

      {pending.length > 0 ? (
        <section className="mt-10">
          <SectionHeading
            title="Waiting for review"
            description="Institutions you filed. They are visible to you and to moderators, and to nobody else until one is approved."
          />
          <ul className="divide-y divide-hairline border-t border-hairline">
            {pending.map((submission) => (
              <li key={submission.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
                <span className="text-sm text-ink">{submission.name}</span>
                <Badge tone="highlight">Pending</Badge>
                <span className="text-xs text-ink-faint">
                  {[submission.city, submission.country].filter(Boolean).join(', ')}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section id="request" className="mt-12 scroll-mt-20">
        <SectionHeading
          title="Request this university"
          description="If your institution is missing, file it here. A moderator approves new ones — Quad does not add institutions automatically, and it does not check that anyone studies where they say they do."
        />
        <Surface className="mt-4 p-5">
          {signedIn ? (
            <RequestUniversityForm defaultName={q} />
          ) : (
            <p className="text-sm text-ink-muted">
              Filing an institution needs an account, because the row records who asked for it.{' '}
              <Link href="/login?next=/universities" className="text-accent-700 underline underline-offset-2">
                Sign in
              </Link>{' '}
              or{' '}
              <Link href="/signup" className="text-accent-700 underline underline-offset-2">
                join Quad
              </Link>{' '}
              first. You can browse the list without one.
            </p>
          )}
        </Surface>
      </section>

      <p className="mt-8 border-t border-hairline pt-4 text-xs text-ink-faint">
        Departments and programmes are not listed yet, so an institution is the finest-grained
        affiliation a profile can carry. The{' '}
        <Link href="/status" className="text-accent-700 underline underline-offset-2">
          build status page
        </Link>{' '}
        says what else is not built.
      </p>
    </div>
  )
}
