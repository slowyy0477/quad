import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { EndOfList, LoadMore } from '@/components/ui/pagination'
import { EmptyState } from '@/components/ui/surface'
import { getUser } from '@/lib/supabase/server'
import { isDataConfigured } from '@/lib/env'
import { ConnectionControls } from '@/features/connections/components/connection-controls'
import { PersonRow } from '@/features/connections/components/person-row'
import {
  getOwnGraphPage, getPageRelationships, getPublicGraphPage, type GraphPageRead,
} from '@/features/connections/graph-reads'
import type { GraphDirection } from '@/features/connections/graph-paging'

const labels: Record<GraphDirection, string> = {
  followers: 'Followers', following: 'Following', connections: 'Connections',
}
const regions: Record<GraphDirection, string> = {
  followers: 'People who follow you', following: 'People you follow', connections: 'Your connections',
}
type SearchParams = Promise<Record<string, string | string[] | undefined>>

function listHref(base: string, direction: GraphDirection, own: boolean) {
  if (own) return direction === 'connections' ? '/connections' : `/connections/${direction}`
  return `${base}/${direction}`
}

async function GraphList({
  page, direction, own, base,
}: {
  page: GraphPageRead; direction: GraphDirection; own: boolean; base: string
}) {
  const label = labels[direction]
  const href = listHref(base, direction, own)
  const relationships = page.error ? null : await getPageRelationships(page.items)
  const nextHref = page.nextCursor ? `${href}?cursor=${encodeURIComponent(page.nextCursor)}` : null
  const region = own ? regions[direction] : label
  return (
    <div className="page-enter mx-auto w-full max-w-3xl space-y-6 px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href={own ? '/me' : base}
            className="inline-flex min-h-11 items-center text-sm text-accent-700 underline-offset-4 hover:underline">
            {own ? 'Your profile' : page.subject?.display_name ?? 'Profile'}
          </Link>
          <h1 className="mt-1 text-3xl">{label}</h1>
          <p className="mt-2 max-w-prose text-sm text-ink-muted">
            {direction === 'connections'
              ? 'Your accepted connections. Only you can open this list.'
              : own ? 'Profiles you are allowed to see. Each list has its own pages.'
                : 'Relationships on this public profile. Privacy and blocks still apply.'}
          </p>
        </div>
        {own ? <Button asChild variant="secondary" size="sm"><Link href="/search?type=people">Find people</Link></Button> : null}
      </header>

      <nav aria-label="Relationship lists" className="flex flex-wrap gap-2 border-b border-hairline pb-4">
        {(own ? ['followers', 'following', 'connections'] as const : ['followers', 'following'] as const)
          .map(kind => (
            <Link key={kind} href={listHref(base, kind, own)} aria-current={direction === kind ? 'page' : undefined}
              className={`inline-flex min-h-11 items-center rounded-md px-4 text-sm font-medium ${
                direction === kind ? 'bg-accent-50 text-accent-700' : 'text-ink-muted hover:bg-paper-sunken'
              }`}>
              {labels[kind]}
            </Link>
          ))}
      </nav>

      {page.error ? (
        <Alert tone="danger" title="The list is unavailable">
          <p>{page.error}</p>
          <Link href={href} className="mt-2 inline-flex min-h-11 items-center underline underline-offset-4">
            Start from the first page
          </Link>
        </Alert>
      ) : (
        <section aria-label={region} className="space-y-4">
          {page.total !== null ? <p className="text-sm text-ink-muted">
            {page.total} visible {direction === 'following' ? 'profiles followed' : direction}
          </p> : null}
          {relationships?.error ? <Alert tone="warning">{relationships.error}</Alert> : null}
          {page.items.length ? (
            <ul className="divide-y divide-hairline">
              {page.items.map(item => {
                const state = relationships?.error ? undefined : relationships?.relationships[item.id]
                return <PersonRow key={item.id} person={item.person}
                  meta={direction === 'connections' ? <time dateTime={item.created_at}>
                    Connected {new Date(item.created_at).toLocaleDateString('en-GB',
                      { day: 'numeric', month: 'short', year: 'numeric' })}
                  </time> : undefined}>
                  {state ? <ConnectionControls
                    profileId={item.person.id} username={item.person.username}
                    displayName={item.person.display_name}
                    state={state.state} connectionId={state.connectionId}
                    isFollowing={state.isFollowing} isBlockingThem={state.isBlockingThem}
                    signedIn showFollow={direction !== 'connections'} size="sm"
                  /> : null}
                </PersonRow>
              })}
            </ul>
          ) : <EmptyState title={direction === 'connections' ? 'You have not connected with anyone yet'
            : direction === 'followers' ? own ? 'Nobody follows you yet' : 'No visible followers'
              : own ? 'You are not following anyone' : 'No visible following'}>
            <p>{own ? 'Find someone through their profile, work or campus.'
              : 'No profiles are available to you in this list.'}</p>
          </EmptyState>}
          {nextHref ? <LoadMore href={nextHref} label={`Load older ${direction}`} />
            : page.items.length ? <EndOfList label={`No older ${direction}.`} /> : null}
        </section>
      )}

      {own ? <nav aria-label="Manage relationships" className="flex flex-wrap gap-x-5 gap-y-2 border-t border-hairline pt-4">
        <Link href="/connections/requests" className="inline-flex min-h-11 items-center text-sm text-accent-700 hover:underline">Connection requests</Link>
        <Link href="/connections/blocked" className="inline-flex min-h-11 items-center text-sm text-accent-700 hover:underline">Blocked accounts</Link>
      </nav> : null}
    </div>
  )
}

export async function OwnGraphPage({
  direction, searchParams,
}: { direction: GraphDirection; searchParams: SearchParams }) {
  const path = listHref('/connections', direction, true)
  if (!isDataConfigured()) return <Alert tone="warning">A backend is not configured. <Link href="/setup">Setup steps</Link>.</Alert>
  if (!await getUser()) redirect(`/login?next=${encodeURIComponent(path)}`)
  const query = await searchParams
  const page = await getOwnGraphPage(direction, { cursor: query.cursor })
  if (page.unavailable) return <Alert tone="warning">Your relationship lists are not available.</Alert>
  return <GraphList page={page} direction={direction} own base="/connections" />
}

export async function PublicGraphPage({
  username, direction, searchParams,
}: { username: string; direction: 'followers' | 'following'; searchParams: SearchParams }) {
  if (!isDataConfigured()) notFound()
  const query = await searchParams
  const page = await getPublicGraphPage(username, direction, { cursor: query.cursor })
  if (page.unavailable) notFound()
  const base = `/u/${encodeURIComponent(page.subject?.username ?? username)}`
  return <GraphList page={page} direction={direction} own={false} base={base} />
}
