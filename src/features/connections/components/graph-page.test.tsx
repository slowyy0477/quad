import type { ComponentProps, ReactElement } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProfileSummary } from '@/features/profiles/queries'
import type {
  getOwnGraphPage, getPageRelationships, getPublicGraphPage, GraphPageRead, PageRelationships,
} from '@/features/connections/graph-reads'
import type { GraphItem } from '@/features/connections/graph-paging'
import type { ConnectionControls } from './connection-controls'
import { OwnGraphPage, PublicGraphPage } from './graph-page'

type ControlProps = ComponentProps<typeof ConnectionControls>
const mocks = vi.hoisted(() => ({
  configured: true,
  user: vi.fn<() => Promise<{ id: string } | null>>(),
  ownPage: vi.fn<typeof getOwnGraphPage>(),
  publicPage: vi.fn<typeof getPublicGraphPage>(),
  relationships: vi.fn<typeof getPageRelationships>(),
  controls: vi.fn<(props: ControlProps) => ReactElement>(),
  redirect: vi.fn<(href: string) => never>(),
  notFound: vi.fn<() => never>(),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/env', () => ({ isDataConfigured: () => mocks.configured }))
vi.mock('@/lib/supabase/server', () => ({ getUser: mocks.user }))
vi.mock('@/features/connections/graph-reads', () => ({
  getOwnGraphPage: mocks.ownPage, getPublicGraphPage: mocks.publicPage,
  getPageRelationships: mocks.relationships,
}))
vi.mock('@/features/connections/components/connection-controls', () => ({
  ConnectionControls: mocks.controls,
}))
vi.mock('next/navigation', () => ({ redirect: mocks.redirect, notFound: mocks.notFound }))
vi.mock('next/link', () => ({
  default: function Link({
    href, children, className, rel, 'aria-label': ariaLabel, 'aria-current': ariaCurrent,
  }: ComponentProps<'a'>) {
    return <a href={href} className={className} rel={rel}
      aria-label={ariaLabel} aria-current={ariaCurrent}>{children}</a>
  },
}))

const OWNER = '11111111-1111-4111-8111-111111111111'
const PEER = '22222222-2222-4222-8222-222222222222'
const CONNECTION = '33333333-3333-4333-8333-333333333333'
const subject: ProfileSummary = {
  id: '44444444-4444-4444-8444-444444444444', username: 'canonical+handle/notes?',
  display_name: 'Synthetic Public Subject', avatar_url: null, headline: null,
}
const owner: ProfileSummary = { ...subject, id: OWNER, username: 'synthetic_owner' }
const peer: GraphItem = {
  id: PEER, created_at: '2026-11-02T07:45:29.205123Z', connectionId: null,
  person: { id: PEER, username: 'synthetic_peer', display_name: 'Synthetic Readable Peer',
    avatar_url: null, headline: 'Readable work' },
}
const BASE = `/u/${encodeURIComponent(subject.username)}`
const NEXT = 'opaque+scope/next?position=value&part=two'
const ownLists = [
  { direction: 'followers', label: 'Followers', href: '/connections/followers',
    region: 'People who follow you', empty: 'Nobody follows you yet' },
  { direction: 'following', label: 'Following', href: '/connections/following',
    region: 'People you follow', empty: 'You are not following anyone' },
  { direction: 'connections', label: 'Connections', href: '/connections',
    region: 'Your connections', empty: 'You have not connected with anyone yet' },
] as const
const publicLists = [
  { direction: 'followers', label: 'Followers', empty: 'No visible followers' },
  { direction: 'following', label: 'Following', empty: 'No visible following' },
] as const

function page(overrides: Partial<GraphPageRead> = {}): GraphPageRead {
  return {
    subject, items: [peer], total: 1, nextCursor: null, error: null, unavailable: false,
    ...overrides,
  }
}
function params(cursor?: string | string[]) {
  return Promise.resolve({ cursor })
}

/**
 * Next's installed Vitest guide does not support rendering async RSCs.
 * Await the exported page and then its one known nested GraphList function.
 * Only the resolved synchronous tree goes to RTL. This is composition unit
 * coverage, not an RSC transport/hydration or browser acceptance test.
 */
async function renderGraphPage(request: Promise<ReactElement>) {
  const element = await request
  if (typeof element.type !== 'function' || element.type.name !== 'GraphList') {
    throw new Error('Expected the current page to compose the GraphList server-function seam.')
  }
  const resolveList = element.type as (props: unknown) => Promise<ReactElement>
  return render(await resolveList(element.props))
}

function expectPublicNavigation(direction: 'followers' | 'following') {
  const nav = screen.getByRole('navigation', { name: 'Relationship lists' })
  expect(within(nav).getAllByRole('link')).toHaveLength(2)
  for (const item of publicLists) {
    const link = within(nav).getByRole('link', { name: item.label })
    expect(link).toHaveAttribute('href', `${BASE}/${item.direction}`)
    if (item.direction === direction) expect(link).toHaveAttribute('aria-current', 'page')
    else expect(link).not.toHaveAttribute('aria-current')
  }
  expect(screen.queryByRole('link', { name: 'Connections' })).not.toBeInTheDocument()
  expect(screen.queryByRole('navigation', { name: 'Manage relationships' })).not.toBeInTheDocument()
  expect(screen.queryByRole('link', { name: 'Find people' })).not.toBeInTheDocument()
  const hrefs = screen.getAllByRole('link').map(link => link.getAttribute('href'))
  expect(hrefs).not.toContain(`${BASE}/connections`)
  expect(hrefs).not.toContain('/connections')
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.configured = true
  mocks.user.mockResolvedValue({ id: OWNER })
  mocks.ownPage.mockResolvedValue(page({ subject: owner }))
  mocks.publicPage.mockResolvedValue(page())
  mocks.relationships.mockResolvedValue({ viewerId: null, relationships: {}, error: null })
  mocks.controls.mockImplementation(({ displayName }) =>
    <span role="group" aria-label={`Scoped controls for ${displayName}`} />)
  mocks.redirect.mockImplementation(() => { throw new Error('Synthetic graph login redirect') })
  mocks.notFound.mockImplementation(() => { throw new Error('Synthetic graph not found') })
})
afterEach(cleanup)

describe('graph server-page composition', () => {
  it.each(ownLists)('composes the own $direction route and separate list navigation', async item => {
    await renderGraphPage(OwnGraphPage({ direction: item.direction, searchParams: params('current_scope') }))
    expect(mocks.ownPage).toHaveBeenCalledExactlyOnceWith(item.direction, { cursor: 'current_scope' })
    expect(mocks.publicPage).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { level: 1, name: item.label })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: item.region })).toHaveTextContent(peer.person.display_name)
    expect(screen.getByRole('link', { name: 'Your profile' })).toHaveAttribute('href', '/me')
    const nav = screen.getByRole('navigation', { name: 'Relationship lists' })
    expect(within(nav).getAllByRole('link')).toHaveLength(3)
    for (const other of ownLists) {
      const link = within(nav).getByRole('link', { name: other.label })
      expect(link).toHaveAttribute('href', other.href)
      if (other.direction === item.direction) expect(link).toHaveAttribute('aria-current', 'page')
      else expect(link).not.toHaveAttribute('aria-current')
    }
    expect(screen.getByRole('link', { name: 'Find people' })).toHaveAttribute('href', '/search?type=people')
    const manage = screen.getByRole('navigation', { name: 'Manage relationships' })
    expect(within(manage).getByRole('link', { name: 'Connection requests' }))
      .toHaveAttribute('href', '/connections/requests')
    expect(within(manage).getByRole('link', { name: 'Blocked accounts' }))
      .toHaveAttribute('href', '/connections/blocked')
  })

  it.each(publicLists)('composes public $direction from the returned canonical subject, with no connection navigation', async item => {
    await renderGraphPage(PublicGraphPage({
      username: 'requested_alias', direction: item.direction, searchParams: params('current_scope'),
    }))
    expect(mocks.publicPage).toHaveBeenCalledExactlyOnceWith('requested_alias', item.direction,
      { cursor: 'current_scope' })
    expect(mocks.ownPage).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { level: 1, name: item.label })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: item.label })).toHaveTextContent(peer.person.display_name)
    expect(screen.getByRole('link', { name: subject.display_name })).toHaveAttribute('href', BASE)
    expectPublicNavigation(item.direction)
  })

  it('does not require a login redirect or invent controls for a reader-approved signed-out public page', async () => {
    mocks.user.mockResolvedValue(null)
    await renderGraphPage(PublicGraphPage({
      username: subject.username, direction: 'followers', searchParams: params(),
    }))
    expect(screen.getByRole('link', { name: peer.person.display_name }))
      .toHaveAttribute('href', '/u/synthetic_peer')
    expect(mocks.redirect).not.toHaveBeenCalled()
    expect(mocks.controls).not.toHaveBeenCalled()
    expectPublicNavigation('followers')
  })
})

describe('graph paging links consume the reader lookahead result', () => {
  // The mocked reader owns filtering/N+1/cursor validation. These tests prove
  // only that its nextCursor, not the displayed length or total, drives links.
  it.each(ownLists)('keeps own $direction paging scoped to its exact route', async item => {
    mocks.ownPage.mockResolvedValue(page({ subject: owner, nextCursor: NEXT }))
    await renderGraphPage(OwnGraphPage({ direction: item.direction, searchParams: params() }))
    expect(screen.getByRole('link', { name: `Load older ${item.direction}` }))
      .toHaveAttribute('href', `${item.href}?cursor=${encodeURIComponent(NEXT)}`)
    expect(screen.getByRole('link', { name: `Load older ${item.direction}` })).toHaveAttribute('rel', 'next')
    expect(screen.queryByText(`No older ${item.direction}.`)).not.toBeInTheDocument()
  })

  it.each(publicLists)('keeps public $direction paging on the encoded canonical subject', async item => {
    mocks.publicPage.mockResolvedValue(page({ nextCursor: NEXT }))
    await renderGraphPage(PublicGraphPage({
      username: 'requested_alias', direction: item.direction, searchParams: params(),
    }))
    expect(screen.getByRole('link', { name: `Load older ${item.direction}` }))
      .toHaveAttribute('href', `${BASE}/${item.direction}?cursor=${encodeURIComponent(NEXT)}`)
    expect(screen.getByRole('link', { name: `Load older ${item.direction}` })).toHaveAttribute('rel', 'next')
    expectPublicNavigation(item.direction)
  })

  it('does not infer another page from a full 25-item page or a larger total when nextCursor is null', async () => {
    const items = Array.from({ length: 25 }, (_, index): GraphItem => ({
      ...peer, id: `synthetic_peer_${index}`,
      person: { ...peer.person, id: `synthetic_peer_${index}`, username: `synthetic_peer_${index}`,
        display_name: `Synthetic Page Peer ${index}` },
    }))
    mocks.ownPage.mockResolvedValue(page({ subject: owner, items, total: 100, nextCursor: null }))
    await renderGraphPage(OwnGraphPage({ direction: 'followers', searchParams: params() }))
    expect(screen.getAllByRole('listitem')).toHaveLength(25)
    expect(screen.queryByRole('link', { name: 'Load older followers' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('No older followers.')
  })

  it('does not convert an unavailable total to a displayed zero', async () => {
    mocks.publicPage.mockResolvedValue(page({ total: null }))
    await renderGraphPage(PublicGraphPage({
      username: subject.username, direction: 'following', searchParams: params(),
    }))
    expect(screen.getByRole('region', { name: 'Following' })).toHaveTextContent(peer.person.display_name)
    expect(screen.queryByText(/^\d+ visible /)).not.toBeInTheDocument()
  })
})

describe('graph errors, empty states and scoped controls', () => {
  it.each(ownLists)('renders an authorized empty own $direction without a paging offer or error', async item => {
    mocks.ownPage.mockResolvedValue(page({ subject: owner, items: [], total: 0 }))
    await renderGraphPage(OwnGraphPage({ direction: item.direction, searchParams: params() }))
    expect(screen.getByRole('region', { name: item.region })).toHaveTextContent(item.empty)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: `Load older ${item.direction}` })).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(mocks.controls).not.toHaveBeenCalled()
  })

  it.each(publicLists)('renders an authorized empty public $direction, not a private-connections metric', async item => {
    mocks.publicPage.mockResolvedValue(page({ items: [], total: 0 }))
    await renderGraphPage(PublicGraphPage({
      username: subject.username, direction: item.direction, searchParams: params(),
    }))
    expect(screen.getByRole('region', { name: item.label })).toHaveTextContent(item.empty)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: `Load older ${item.direction}` })).not.toBeInTheDocument()
    expectPublicNavigation(item.direction)
  })

  it.each(['own', 'public'] as const)('keeps %s cursor/read errors distinct from empty or stale successful content', async audience => {
    const error = 'This cursor is malformed or belongs to another relationship list.'
    const result = page({ error, total: 99, nextCursor: NEXT })
    mocks.ownPage.mockResolvedValue(result)
    mocks.publicPage.mockResolvedValue(result)
    await renderGraphPage(audience === 'own'
      ? OwnGraphPage({ direction: 'following', searchParams: params(['wrong', 'scope']) })
      : PublicGraphPage({ username: subject.username, direction: 'following',
        searchParams: params(['wrong', 'scope']) }))
    expect(screen.getByRole('alert')).toHaveTextContent('The list is unavailable')
    expect(screen.getByRole('alert')).toHaveTextContent(error)
    expect(screen.getByRole('link', { name: 'Start from the first page' }))
      .toHaveAttribute('href', audience === 'own' ? '/connections/following' : `${BASE}/following`)
    expect(screen.queryByText('You are not following anyone')).not.toBeInTheDocument()
    expect(screen.queryByText('No visible following')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: peer.person.display_name })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Load older following' })).not.toBeInTheDocument()
    expect(mocks.relationships).not.toHaveBeenCalled()
    expect(mocks.controls).not.toHaveBeenCalled()
    if (audience === 'own') expect(mocks.ownPage).toHaveBeenCalledExactlyOnceWith('following',
      { cursor: ['wrong', 'scope'] })
    else expect(mocks.publicPage).toHaveBeenCalledExactlyOnceWith(subject.username, 'following',
      { cursor: ['wrong', 'scope'] })
  })

  it.each(['own', 'public'] as const)('reports a %s relationship-state error without fabricating default none controls', async audience => {
    mocks.relationships.mockResolvedValue({
      viewerId: OWNER, relationships: {}, error: 'Relationship controls could not be loaded. Please try again.',
    })
    await renderGraphPage(audience === 'own'
      ? OwnGraphPage({ direction: 'following', searchParams: params() })
      : PublicGraphPage({ username: subject.username, direction: 'following', searchParams: params() }))
    expect(screen.getByRole('alert')).toHaveTextContent('Relationship controls could not be loaded.')
    expect(screen.getByRole('link', { name: peer.person.display_name })).toBeInTheDocument()
    expect(screen.queryByText('No visible following')).not.toBeInTheDocument()
    expect(screen.queryByText('You are not following anyone')).not.toBeInTheDocument()
    expect(mocks.relationships).toHaveBeenCalledExactlyOnceWith([peer])
    expect(mocks.controls).not.toHaveBeenCalled()
  })

  it.each(ownLists)('passes supplied current-page relationship IDs/state on $direction, without synthesizing unreturned peers', async item => {
    const second: GraphItem = { ...peer, id: '55555555-5555-4555-8555-555555555555',
      created_at: '2026-11-01T07:45:29.205123Z',
      connectionId: item.direction === 'connections' ? '66666666-6666-4666-8666-666666666666' : null,
      person: { ...peer.person, id: '55555555-5555-4555-8555-555555555555',
        username: 'second_peer', display_name: 'Synthetic Unreturned State Peer' } }
    const items = [{ ...peer, connectionId: item.direction === 'connections' ? CONNECTION : null }, second]
    const relationships: PageRelationships = { viewerId: OWNER, relationships: {
      [PEER]: { state: 'connected', connectionId: CONNECTION, isFollowing: true, isBlockingThem: false },
    }, error: null }
    mocks.ownPage.mockResolvedValue(page({ subject: owner, items, total: 2 }))
    mocks.relationships.mockResolvedValue(relationships)
    const view = await renderGraphPage(OwnGraphPage({ direction: item.direction, searchParams: params() }))
    expect(mocks.relationships).toHaveBeenCalledExactlyOnceWith(items)
    expect(mocks.controls.mock.calls.map(([props]) => props)).toEqual([expect.objectContaining({
      profileId: PEER, username: peer.person.username, displayName: peer.person.display_name,
      state: 'connected', connectionId: CONNECTION, isFollowing: true, isBlockingThem: false,
      signedIn: true, showFollow: item.direction !== 'connections', size: 'sm',
    })])
    expect(screen.getByRole('link', { name: second.person.display_name })).toBeInTheDocument()
    if (item.direction === 'connections') {
      expect(view.container.querySelector('time')).toHaveAttribute('datetime', peer.created_at)
    } else expect(view.container.querySelector('time')).toBeNull()
  })

  it('suppresses even a populated partial control map when the relationship read failed', async () => {
    mocks.relationships.mockResolvedValue({
      viewerId: OWNER,
      relationships: {
        [PEER]: { state: 'connected', connectionId: CONNECTION, isFollowing: true, isBlockingThem: false },
      },
      error: 'Some page relationship states could not be read.',
    })
    await renderGraphPage(OwnGraphPage({ direction: 'followers', searchParams: params() }))
    expect(screen.getByRole('alert')).toHaveTextContent('Some page relationship states could not be read.')
    expect(screen.getByRole('link', { name: peer.person.display_name })).toBeInTheDocument()
    expect(mocks.controls).not.toHaveBeenCalled()
  })
})

describe('graph page guards', () => {
  it.each(ownLists)('redirects signed-out own $direction before graph reads to the exact safe destination', async item => {
    mocks.user.mockResolvedValue(null)
    await expect(OwnGraphPage({ direction: item.direction, searchParams: params() }))
      .rejects.toThrow('Synthetic graph login redirect')
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith(`/login?next=${encodeURIComponent(item.href)}`)
    expect(mocks.ownPage).not.toHaveBeenCalled()
    expect(mocks.publicPage).not.toHaveBeenCalled()
    expect(mocks.relationships).not.toHaveBeenCalled()
  })

  it.each(publicLists)('uses notFound for an unavailable public $direction subject, not an empty list', async item => {
    mocks.publicPage.mockResolvedValue(page({
      subject: null, items: [], total: null, unavailable: true,
    }))
    await expect(PublicGraphPage({
      username: 'missing_or_unreadable', direction: item.direction, searchParams: params(),
    })).rejects.toThrow('Synthetic graph not found')
    expect(mocks.notFound).toHaveBeenCalledTimes(1)
    expect(mocks.redirect).not.toHaveBeenCalled()
    expect(mocks.relationships).not.toHaveBeenCalled()
    expect(mocks.controls).not.toHaveBeenCalled()
  })

  it('keeps an unavailable own graph distinct from an authorized empty list', async () => {
    mocks.ownPage.mockResolvedValue(page({ subject: null, items: [], total: null, unavailable: true }))
    render(await OwnGraphPage({ direction: 'connections', searchParams: params() }))
    expect(screen.getByRole('alert')).toHaveTextContent('Your relationship lists are not available.')
    expect(screen.queryByText('You have not connected with anyone yet')).not.toBeInTheDocument()
    expect(mocks.relationships).not.toHaveBeenCalled()
  })

  it('offers setup rather than querying an unconfigured own graph', async () => {
    mocks.configured = false
    render(await OwnGraphPage({ direction: 'followers', searchParams: params() }))
    expect(screen.getByRole('alert')).toHaveTextContent('A backend is not configured.')
    expect(screen.getByRole('link', { name: 'Setup steps' })).toHaveAttribute('href', '/setup')
    expect(mocks.user).not.toHaveBeenCalled()
    expect(mocks.ownPage).not.toHaveBeenCalled()
  })

  it('uses notFound without a public graph read when no backend is configured', async () => {
    mocks.configured = false
    await expect(PublicGraphPage({
      username: subject.username, direction: 'following', searchParams: params(),
    })).rejects.toThrow('Synthetic graph not found')
    expect(mocks.publicPage).not.toHaveBeenCalled()
    expect(mocks.relationships).not.toHaveBeenCalled()
  })
})
